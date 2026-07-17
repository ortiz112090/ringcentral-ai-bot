import twilio, { Twilio } from "twilio";
import { resolveEffectiveConfig } from "../config";
import { BOT_ID } from "../db/remoteConfig";

/**
 * Twilio REST client factory for the current tenant.
 *
 * MULTI-TENANT: account_sid/auth_token come from resolveEffectiveConfig().twilio,
 * which reads api_credentials (provider "twilio") first and only falls back to env
 * vars for the primary bot (see credentialFirst in ../config). A non-primary
 * tenant with no DB credentials therefore gets `null` here rather than silently
 * borrowing another tenant's env secrets.
 *
 * The client is rebuilt when credentials change (dashboard rotation picked up by a
 * config reload), mirroring the RingCentral client's snapshot-and-rebuild pattern.
 */

interface CachedClient {
  client: Twilio;
  accountSid: string;
  authToken: string;
}

let cached: CachedClient | null = null;

/**
 * Resolve this tenant's Twilio auth token (for signature validation). Returns
 * undefined when unset/absent — callers fail closed (reject the request) because
 * an unvalidatable webhook must never be trusted.
 */
export async function getTwilioAuthToken(): Promise<string | undefined> {
  return (await resolveEffectiveConfig()).twilio.authToken;
}

/**
 * Build (or reuse) the tenant's authenticated Twilio REST client. Returns null
 * when account_sid or auth_token is missing for this tenant.
 */
export async function getTwilioClient(): Promise<Twilio | null> {
  const { accountSid, authToken } = (await resolveEffectiveConfig()).twilio;
  if (!accountSid || !authToken) return null;

  if (
    cached &&
    cached.accountSid === accountSid &&
    cached.authToken === authToken
  ) {
    return cached.client;
  }

  const client = twilio(accountSid, authToken);
  cached = { client, accountSid, authToken };
  return client;
}

/** The tenant id this module operates for (exported for clear log context). */
export const TWILIO_BOT_ID = BOT_ID;
