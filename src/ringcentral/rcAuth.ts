import { logger } from "../logger";
import { persistRcRefreshToken, setRcSignedInLabel } from "../db/rcOAuthQueries";

/**
 * RingCentral OAuth token manager + token-endpoint helpers (PR H).
 *
 * Extends the existing JWT-based RC auth (see ./client.ts) with the Authorization
 * Code / refresh-token flow. Talks to the RC token endpoint directly over HTTP
 * (basic auth client_id:client_secret) rather than through the SDK, so the flow is
 * self-contained and easily testable, and so we can persist the ROTATED refresh
 * token that RingCentral returns on every token response.
 *
 * Precedence (enforced by the caller in client.ts): a bot's OAuth refresh token,
 * when present, wins over the JWT. getRcOAuthAccessToken() returns the OAuth access
 * token, or null to signal "fall back to JWT" (no refresh token usable / expired).
 */

const TOKEN_PATH = "/restapi/oauth/token";

/** Refresh the in-memory access token this many ms BEFORE its real expiry. */
const EXPIRY_SKEW_MS = 60_000;
/** Fallback lifetime when RC omits expires_in (RC access tokens are ~1h). */
const DEFAULT_TTL_MS = 3600_000;

export interface RcTokenResponse {
  access_token: string;
  refresh_token?: string;
  /** Access-token lifetime in seconds. */
  expires_in?: number;
  token_type?: string;
}

/** An error from the RC token endpoint, carrying the RC `error` code (e.g. invalid_grant). */
export class RcTokenError extends Error {
  readonly rcError: string;
  readonly status: number;
  constructor(rcError: string, status: number) {
    super(`RingCentral token request failed: ${rcError}`);
    this.name = "RcTokenError";
    this.rcError = rcError;
    this.status = status;
  }
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

function tokenUrl(serverUrl: string): string {
  return `${serverUrl.replace(/\/+$/, "")}${TOKEN_PATH}`;
}

/**
 * POST the RC token endpoint with basic auth + form-encoded params. Throws
 * RcTokenError (carrying the RC error code) on a non-2xx response. Never leaks
 * token values.
 */
async function postToken(
  serverUrl: string,
  clientId: string,
  clientSecret: string,
  params: Record<string, string>
): Promise<RcTokenResponse> {
  const res = await fetch(tokenUrl(serverUrl), {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(clientId, clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
  });

  const raw = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }

  if (!res.ok) {
    const code = typeof json.error === "string" ? json.error : `http_${res.status}`;
    throw new RcTokenError(code, res.status);
  }
  return json as unknown as RcTokenResponse;
}

/**
 * Exchange an authorization code for tokens (callback path). redirectUri MUST be
 * identical to the one used on the /authorize request.
 */
export async function exchangeAuthorizationCode(input: {
  serverUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<RcTokenResponse> {
  return postToken(input.serverUrl, input.clientId, input.clientSecret, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
  });
}

// ---- Per-bot in-memory access-token cache ----
interface CachedToken {
  accessToken: string;
  /** Epoch ms at which we consider the token due for refresh (real expiry − skew). */
  expiresAtMs: number;
}
const accessTokenCache = new Map<string, CachedToken>();

/** Test-only: reset the per-bot access-token cache between cases. */
export function __clearRcAuthCacheForTests(): void {
  accessTokenCache.clear();
}

/**
 * Obtain a valid OAuth access token for this bot via grant_type=refresh_token,
 * caching it in memory (per bot) until ~60s before expiry.
 *
 *   - Cache hit (not near expiry) → return the cached access token, no HTTP.
 *   - Otherwise refresh: ALWAYS persist the rotated refresh_token the response
 *     carries (RC rotates them), cache the new access token, and return it.
 *   - invalid_grant (revoked/expired sign-in) → clear the cached token, warn
 *     clearly, clear the dashboard label so it shows signed-out, and return null
 *     so the caller falls back to the JWT flow.
 *   - Any other failure → log and return null (fall back to JWT); the old label
 *     is left in place (the sign-in may still be valid; this was a transient blip).
 */
export async function getRcOAuthAccessToken(input: {
  botId: string;
  serverUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<string | null> {
  const { botId } = input;

  const cached = accessTokenCache.get(botId);
  if (cached && Date.now() < cached.expiresAtMs) {
    return cached.accessToken;
  }

  let resp: RcTokenResponse;
  try {
    resp = await postToken(input.serverUrl, input.clientId, input.clientSecret, {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    });
  } catch (err) {
    if (err instanceof RcTokenError && err.rcError === "invalid_grant") {
      accessTokenCache.delete(botId);
      logger.warn("RingCentral sign-in expired — sign in again from the dashboard", { botId });
      await setRcSignedInLabel("", botId);
      return null;
    }
    logger.error("RingCentral refresh-token exchange failed; falling back to JWT", {
      botId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // RC rotates refresh tokens — persist whatever the response carried.
  if (resp.refresh_token) {
    await persistRcRefreshToken(resp.refresh_token, botId);
  }

  const ttlMs =
    typeof resp.expires_in === "number" && Number.isFinite(resp.expires_in)
      ? resp.expires_in * 1000
      : DEFAULT_TTL_MS;
  accessTokenCache.set(botId, {
    accessToken: resp.access_token,
    expiresAtMs: Date.now() + Math.max(0, ttlMs - EXPIRY_SKEW_MS),
  });
  return resp.access_token;
}
