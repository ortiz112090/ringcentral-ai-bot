import { Router, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config, resolveEffectiveConfig, rcOAuthCallbackUrl } from "../config";
import { logger } from "../logger";
import { BOT_ID, loadRemoteConfig } from "../db/remoteConfig";
import { exchangeAuthorizationCode } from "../ringcentral/rcAuth";
import { persistRcRefreshToken, setRcSignedInLabel } from "../db/rcOAuthQueries";
import { syncRcSmsOptions } from "./rcProvisioning";

/**
 * "Sign in with RingCentral" — per-bot OAuth Authorization Code flow (PR H).
 *
 *   GET /rc/oauth/start?bot_id=<uuid>&return_to=<https dashboard url>
 *     302 → RingCentral /authorize, carrying a signed `state` so the callback can
 *     trust the bot_id + return_to it echoes back.
 *   GET /rc/oauth/callback?code&state
 *     Verify state, exchange the code for tokens, persist the (rotated) refresh
 *     token per-bot in api_credentials, save a display label, kick a one-off
 *     rc_sms_options sync, and 302 back to the dashboard.
 *
 * The bot then acts AS the signed-in user ('~'), so sending as another extension
 * needs no account-level permission. Endpoints NEVER throw and NEVER leak tokens in
 * URLs or logs — any failure logs a warning and redirects with ?rc_error=<code>.
 */
export const rcOAuthRouter = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** State freshness window: a start→callback round trip must complete within 15 min. */
const STATE_MAX_AGE_MS = 15 * 60 * 1000;

interface StatePayload {
  bot_id: string;
  return_to: string;
  ts: number;
}

/** The HMAC key for signing state — the existing Supabase service-role key (no new env). */
function stateSecret(): string {
  return config.supabase.serviceRoleKey;
}

/** base64url(JSON payload) + '.' + base64url(HMAC-SHA256(payload)). */
function signState(payload: StatePayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", stateSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/** Constant-time base64url signature compare; false on any length/format mismatch. */
function signaturesMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Verify a state string: signature must match AND ts must be within the freshness
 * window. Returns the payload, or null on any tampering / staleness / parse error.
 */
function verifyState(state: string): StatePayload | null {
  if (typeof state !== "string" || state === "") return null;
  const dot = state.indexOf(".");
  if (dot <= 0 || dot === state.length - 1) return null;
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);

  const expected = createHmac("sha256", stateSecret()).update(body).digest("base64url");
  if (!signaturesMatch(sig, expected)) return null;

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload.bot_id !== "string" ||
    typeof payload.return_to !== "string" ||
    typeof payload.ts !== "number"
  ) {
    return null;
  }
  if (!Number.isFinite(payload.ts) || Date.now() - payload.ts > STATE_MAX_AGE_MS) {
    return null; // stale (or clock-skewed into the future beyond the window)
  }
  return payload;
}

/** True when `value` is a syntactically valid https:// URL. */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Append a query param to a URL, preserving any existing query. */
function withQueryParam(rawUrl: string, key: string, value: string): string {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set(key, value);
    return url.toString();
  } catch {
    const sep = rawUrl.includes("?") ? "&" : "?";
    return `${rawUrl}${sep}${key}=${encodeURIComponent(value)}`;
  }
}

/**
 * GET /rc/oauth/start — begin the OAuth flow. Validates inputs (uuid bot_id, https
 * return_to), then 302s to RingCentral's /authorize with a signed state. Because a
 * bad return_to can't be trusted as a redirect target, invalid input yields 400
 * rather than an open redirect.
 */
export async function handleRcOAuthStart(req: Request, res: Response): Promise<Response | void> {
  const botId = typeof req.query.bot_id === "string" ? req.query.bot_id : "";
  const returnTo = typeof req.query.return_to === "string" ? req.query.return_to : "";

  if (!UUID_RE.test(botId)) {
    logger.warn("RC OAuth start rejected: invalid bot_id");
    return res.status(400).send("invalid bot_id");
  }
  if (!isHttpsUrl(returnTo)) {
    logger.warn("RC OAuth start rejected: return_to is not https");
    return res.status(400).send("invalid return_to");
  }

  try {
    const { ringcentral } = await resolveEffectiveConfig();
    if (!ringcentral.clientId) {
      logger.warn("RC OAuth start: no RingCentral client_id configured for this bot", { botId });
      return res.redirect(302, withQueryParam(returnTo, "rc_error", "not_configured"));
    }

    const state = signState({ bot_id: botId, return_to: returnTo, ts: Date.now() });
    const authorizeUrl = new URL(
      `${ringcentral.serverUrl.replace(/\/+$/, "")}/restapi/oauth/authorize`
    );
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", ringcentral.clientId);
    authorizeUrl.searchParams.set("redirect_uri", rcOAuthCallbackUrl());
    authorizeUrl.searchParams.set("state", state);

    return res.redirect(302, authorizeUrl.toString());
  } catch (err) {
    logger.warn("RC OAuth start failed", {
      botId,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.redirect(302, withQueryParam(returnTo, "rc_error", "start_failed"));
  }
}

/**
 * Fetch the signed-in user's identity and build a human display label, e.g.
 * "Joal Ortiz — ext 499". Uses the freshly-obtained access token directly (Bearer),
 * NOT the SDK, so it reflects the just-signed-in user. Returns "" on any failure —
 * the caller keeps going (a missing label must not fail the sign-in).
 */
async function fetchSignedInLabel(serverUrl: string, accessToken: string): Promise<string> {
  try {
    const res = await fetch(
      `${serverUrl.replace(/\/+$/, "")}/restapi/v1.0/account/~/extension/~`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } }
    );
    if (!res.ok) return "";
    const j = (await res.json()) as {
      name?: unknown;
      extensionNumber?: unknown;
      contact?: { firstName?: unknown; lastName?: unknown };
    };
    const name =
      typeof j.name === "string" && j.name.trim() !== ""
        ? j.name.trim()
        : [j.contact?.firstName, j.contact?.lastName]
            .filter((p): p is string => typeof p === "string" && p.trim() !== "")
            .join(" ")
            .trim();
    const ext = j.extensionNumber != null ? String(j.extensionNumber) : "";
    const parts = [name || "RingCentral user"];
    if (ext) parts.push(`ext ${ext}`);
    return parts.join(" — ");
  } catch {
    return "";
  }
}

/**
 * GET /rc/oauth/callback — finish the flow. Verifies state (signature + freshness),
 * exchanges the code, persists the rotated refresh token + label, triggers a
 * one-off options sync, and redirects back to the dashboard. Never throws; never
 * leaks tokens.
 */
export async function handleRcOAuthCallback(req: Request, res: Response): Promise<Response | void> {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const rawState = typeof req.query.state === "string" ? req.query.state : "";

  const payload = verifyState(rawState);
  if (!payload) {
    // Tampered / stale / malformed state → the return_to is untrusted, so we cannot
    // safely redirect. Reject outright; nothing is persisted.
    logger.warn("RC OAuth callback rejected: invalid or stale state");
    return res.status(400).send("invalid state");
  }

  const returnTo = payload.return_to;

  // Single-tenant deploy: the signed bot_id must be THIS deployment's tenant.
  if (payload.bot_id !== BOT_ID) {
    logger.warn("RC OAuth callback rejected: state bot_id does not match this tenant", {
      botId: BOT_ID,
    });
    return res.redirect(302, withQueryParam(returnTo, "rc_error", "bot_mismatch"));
  }

  if (code === "") {
    logger.warn("RC OAuth callback: missing authorization code", { botId: BOT_ID });
    return res.redirect(302, withQueryParam(returnTo, "rc_error", "no_code"));
  }

  try {
    const { ringcentral } = await resolveEffectiveConfig();
    if (!ringcentral.clientId || !ringcentral.clientSecret) {
      logger.warn("RC OAuth callback: RingCentral client credentials not configured", {
        botId: BOT_ID,
      });
      return res.redirect(302, withQueryParam(returnTo, "rc_error", "not_configured"));
    }

    let tokens;
    try {
      tokens = await exchangeAuthorizationCode({
        serverUrl: ringcentral.serverUrl,
        clientId: ringcentral.clientId,
        clientSecret: ringcentral.clientSecret,
        code,
        redirectUri: rcOAuthCallbackUrl(),
      });
    } catch (err) {
      logger.warn("RC OAuth callback: token exchange failed", {
        botId: BOT_ID,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.redirect(302, withQueryParam(returnTo, "rc_error", "token_exchange"));
    }

    if (!tokens.refresh_token) {
      logger.warn("RC OAuth callback: token response carried no refresh_token", {
        botId: BOT_ID,
      });
      return res.redirect(302, withQueryParam(returnTo, "rc_error", "no_refresh_token"));
    }

    // Persist the refresh token (secret) and the display label.
    await persistRcRefreshToken(tokens.refresh_token, BOT_ID);
    const label = await fetchSignedInLabel(ringcentral.serverUrl, tokens.access_token);
    await setRcSignedInLabel(label, BOT_ID);

    // Refresh the config cache so the just-persisted refresh token is used, then
    // kick a one-off sender-options sync so the dropdown fills right away.
    await loadRemoteConfig();
    void syncRcSmsOptions();

    logger.info("RingCentral sign-in complete", { botId: BOT_ID, hasLabel: label !== "" });
    return res.redirect(302, withQueryParam(returnTo, "rc_connected", "1"));
  } catch (err) {
    logger.warn("RC OAuth callback failed", {
      botId: BOT_ID,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.redirect(302, withQueryParam(returnTo, "rc_error", "callback_failed"));
  }
}

rcOAuthRouter.get("/rc/oauth/start", handleRcOAuthStart);
rcOAuthRouter.get("/rc/oauth/callback", handleRcOAuthCallback);
