import { SDK } from "@ringcentral/sdk";
import { resolveEffectiveConfig } from "../config";
import { BOT_ID } from "../db/remoteConfig";
import { logger } from "../logger";

/**
 * RingCentral SDK wrapper using the JWT (server-to-server) auth flow.
 *
 * MULTI-TENANT: the SDK client is built LAZILY from resolveEffectiveConfig()
 * (env + this tenant's Supabase credentials), NOT eagerly at module load from
 * the raw env baseline. Building eagerly was wrong: for correctly-configured
 * non-primary tenants the env baseline is empty, so the SDK was constructed with
 * blank credentials and every login failed with "Client authentication is
 * required" even though valid credentials existed in Supabase. Effective config
 * is only available after loadRemoteConfig() has warmed the cache at startup, so
 * construction is deferred until the first ensureLogin()/rc* call.
 */

type RcPlatform = ReturnType<InstanceType<typeof SDK>["platform"]>;

interface RcClient {
  sdk: SDK;
  platform: RcPlatform;
  // Snapshot of the credentials this client was built with, so we can detect a
  // dashboard-driven credential change and rebuild instead of reusing a client
  // authenticated with stale secrets.
  clientId: string;
  clientSecret: string;
  serverUrl: string;
  jwt: string;
}

let current: RcClient | null = null;
let loginPromise: Promise<void> | null = null;

// Serializes ensureClient() so concurrent calls never build two SDK instances or
// race a credential-change rebuild. resolveEffectiveConfig() reads a synchronous
// in-memory cache, so this chain stays cheap.
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Return the current SDK client, building (or rebuilding on credential change)
 * as needed from the tenant's effective config. Throws a clear, tenant-scoped
 * error — with NO secret values — when client_id/client_secret/jwt are missing,
 * so a misconfigured tenant fails loudly instead of silently sending blank
 * credentials to RingCentral. Callers (ultimately index.ts startup and the
 * webhook/call paths) already treat a thrown RingCentral error as non-fatal.
 */
async function ensureClient(): Promise<RcClient> {
  return serialize(async () => {
    const { ringcentral } = await resolveEffectiveConfig();
    const { clientId, clientSecret, serverUrl, jwt } = ringcentral;

    const missing: string[] = [];
    if (!clientId) missing.push("client_id");
    if (!clientSecret) missing.push("client_secret");
    if (!jwt) missing.push("jwt");
    if (missing.length > 0) {
      throw new Error(
        `RingCentral credentials missing/incomplete for tenant BOT_ID=${BOT_ID}: ` +
          `${missing.join(", ")}. Set them in Supabase api_credentials (provider ` +
          `"ringcentral") for this bot; env-var fallback applies only to the primary bot.`
      );
    }

    const changed =
      !current ||
      current.clientId !== clientId ||
      current.clientSecret !== clientSecret ||
      current.serverUrl !== serverUrl ||
      current.jwt !== jwt;

    if (changed) {
      if (current) {
        // Credentials rotated (e.g. dashboard edit picked up by a config reload):
        // drop the old authenticated session so we don't leak it, and force a
        // fresh login on the new client.
        const old = current;
        try {
          await old.platform.logout();
        } catch (err) {
          logger.warn("Failed to log out previous RingCentral session during rebuild", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        logger.info("RingCentral credentials changed; rebuilt SDK client", { botId: BOT_ID });
      }
      const sdk = new SDK({ server: serverUrl, clientId, clientSecret });
      current = {
        sdk,
        platform: sdk.platform(),
        clientId: clientId as string,
        clientSecret: clientSecret as string,
        serverUrl,
        jwt: jwt as string,
      };
      loginPromise = null; // any prior login belonged to the old client
    }

    return current as RcClient;
  });
}

/** Ensures we have a valid, authenticated platform session (idempotent). */
export async function ensureLogin(): Promise<void> {
  const client = await ensureClient();
  if (await client.platform.loggedIn()) return;
  if (!loginPromise) {
    loginPromise = client.platform
      .login({ jwt: client.jwt })
      .then(() => {
        logger.info("RingCentral platform authenticated");
      })
      .catch((err) => {
        logger.error("RingCentral login failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      })
      .finally(() => {
        loginPromise = null;
      });
  }
  await loginPromise;
}

/** The authenticated platform for the current tenant. */
async function authedPlatform(): Promise<RcPlatform> {
  await ensureLogin();
  return (current as RcClient).platform;
}

// ---- Rate-limit (HTTP 429) backoff ----
//
// RingCentral throttles per-account; a burst of webhooks can trip "Request rate
// exceeded" (HTTP 429). We retry ONLY 429s with exponential backoff. All other
// errors (other 4xx/5xx, auth, network) propagate immediately as before.

const RATE_LIMIT_STATUS = 429;
const MAX_RATE_LIMIT_RETRIES = 4;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract the HTTP status from a RingCentral SDK error. The SDK throws an
 * ApiError carrying `.response` (its fetch-style Response), whose `.status` is
 * the numeric HTTP status (see @ringcentral/sdk Client: `_rateLimitStatus = 429`).
 */
function httpStatusOf(err: unknown): number | undefined {
  const status = (err as { response?: { status?: unknown } })?.response?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Run a RingCentral API call, retrying ONLY on HTTP 429 with exponential backoff
 * (1s, 2s, 4s, 8s … capped at 30s), up to MAX_RATE_LIMIT_RETRIES attempts. On a
 * non-429 error, or once retries are exhausted, the error is rethrown unchanged.
 */
async function withRateLimitRetry<T>(label: string, op: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await op();
    } catch (err) {
      if (httpStatusOf(err) !== RATE_LIMIT_STATUS || attempt >= MAX_RATE_LIMIT_RETRIES) {
        throw err;
      }
      const backoffMs = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
      attempt += 1;
      logger.warn("RingCentral rate limited (429); backing off before retry", {
        endpoint: label,
        attempt,
        maxRetries: MAX_RATE_LIMIT_RETRIES,
        backoffMs,
      });
      await delay(backoffMs);
    }
  }
}

/** Authenticated GET helper (retries on 429). */
export async function rcGet(endpoint: string): Promise<any> {
  const platform = await authedPlatform();
  const res = await withRateLimitRetry(`GET ${endpoint}`, () => platform.get(endpoint));
  return res.json();
}

/** Authenticated POST helper (retries on 429). */
export async function rcPost(endpoint: string, body?: unknown): Promise<any> {
  const platform = await authedPlatform();
  const res = await withRateLimitRetry(`POST ${endpoint}`, () => platform.post(endpoint, body));
  return res.json();
}

/** Authenticated DELETE helper (retries on 429). */
export async function rcDelete(endpoint: string): Promise<void> {
  const platform = await authedPlatform();
  await withRateLimitRetry(`DELETE ${endpoint}`, () => platform.delete(endpoint));
}
