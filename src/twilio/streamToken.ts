import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Per-call proof for the /twilio/media WebSocket.
 *
 * Twilio does not sign media-stream connections, so the voice webhook mints a
 * short-lived token bound to the specific CallSid and hands it to Twilio as a
 * custom <Parameter>. The media socket recomputes it on "start" and refuses any
 * connection without a valid, unexpired, call-bound token — stopping an attacker
 * who discovers the wss URL from opening a paid Realtime session with a forged
 * CallSid.
 *
 * Token = `${expiresEpochSeconds}.${hexHmac}` where
 *   hexHmac = HMAC-SHA256(key = tenant Twilio auth token, msg = `${callSid}.${exp}`).
 * The auth token is a shared secret only this service and Twilio's account holder
 * know; it never leaves the backend.
 */

const DEFAULT_TTL_SECONDS = 300; // 5 minutes; stream start happens within seconds.

function sign(callSid: string, exp: number, authToken: string): string {
  return createHmac("sha256", authToken).update(`${callSid}.${exp}`).digest("hex");
}

/**
 * Mint a call-bound token that expires `ttlSeconds` from now. `authToken` must be
 * this tenant's Twilio auth token (the HMAC key).
 */
export function createStreamToken(
  callSid: string,
  authToken: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): string {
  const exp = nowSeconds + ttlSeconds;
  return `${exp}.${sign(callSid, exp, authToken)}`;
}

/**
 * Verify a token is well-formed, unexpired, and a valid HMAC for THIS callSid.
 * Constant-time digest comparison. Returns false on any malformed/expired/mismatch
 * input rather than throwing, so callers can simply reject.
 */
export function verifyStreamToken(
  callSid: string,
  token: string | undefined | null,
  authToken: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  if (!token || !authToken || !callSid) return false;

  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expStr = token.slice(0, dot);
  const providedHex = token.slice(dot + 1);
  if (!/^\d+$/.test(expStr) || !/^[0-9a-f]+$/i.test(providedHex)) return false;

  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < nowSeconds) return false; // expired

  const expectedHex = sign(callSid, exp, authToken);
  const provided = Buffer.from(providedHex, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
