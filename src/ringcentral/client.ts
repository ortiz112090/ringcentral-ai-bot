import { SDK } from "@ringcentral/sdk";
import { config } from "../config";
import { logger } from "../logger";

/**
 * RingCentral SDK wrapper using the JWT (server-to-server) auth flow.
 * A single long-lived platform instance is shared across the app; the SDK
 * auto-refreshes the access token as needed.
 */

const rcsdk = new SDK({
  server: config.ringcentral.serverUrl,
  clientId: config.ringcentral.clientId,
  clientSecret: config.ringcentral.clientSecret,
});

const platform = rcsdk.platform();

let loginPromise: Promise<void> | null = null;

/** Ensures we have a valid, authenticated platform session (idempotent). */
export async function ensureLogin(): Promise<void> {
  if (await platform.loggedIn()) return;
  if (!loginPromise) {
    loginPromise = platform
      .login({ jwt: config.ringcentral.jwt })
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

/** Authenticated GET helper. */
export async function rcGet(endpoint: string): Promise<any> {
  await ensureLogin();
  const res = await platform.get(endpoint);
  return res.json();
}

/** Authenticated POST helper. */
export async function rcPost(endpoint: string, body?: unknown): Promise<any> {
  await ensureLogin();
  const res = await platform.post(endpoint, body);
  return res.json();
}

/** Authenticated DELETE helper. */
export async function rcDelete(endpoint: string): Promise<void> {
  await ensureLogin();
  await platform.delete(endpoint);
}

export { rcsdk, platform };
