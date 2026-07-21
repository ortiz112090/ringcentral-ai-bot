import { logger } from "../logger";

/**
 * In-memory registry of LIVE outbound campaign calls, keyed by Twilio CallSid.
 *
 * The outbound worker registers a call the moment it dials (once Twilio returns a
 * CallSid) and it stays registered until the call is finalized from the Twilio
 * status callback (or pruned as stale). It serves two jobs for a single-instance
 * v1:
 *   1. Concurrency cap — liveOutboundCount() lets the worker enforce "at most one
 *      live outbound call" (never claim a new contact while one is dialing/talking).
 *   2. CallSid → contact mapping — the status callback carries only the CallSid, so
 *      this is how we link a terminal call status back to its campaign_contacts row.
 *
 * This is a LEAF module (only depends on the logger) so it can be imported from the
 * inbound voice webhook without pulling in Supabase — that keeps the webhook's
 * status-callback finalize path gated behind a cheap isOutboundCall() check and its
 * heavier finalize logic behind a dynamic import.
 *
 * NOTE: like conversationStore, this lives in one process. Scaling to multiple
 * instances would require moving it to Redis/Supabase.
 */

export interface OutboundCall {
  callSid: string;
  contactId: number;
  campaignId: string;
  /** Epoch ms when the call was registered (dialed) — used for stale pruning. */
  startedAtMs: number;
}

const calls = new Map<string, OutboundCall>();

/** Register a freshly-dialed outbound call so it holds a concurrency slot. */
export function registerOutboundCall(callSid: string, contactId: number, campaignId: string): void {
  calls.set(callSid, { callSid, contactId, campaignId, startedAtMs: Date.now() });
}

/** True when this CallSid belongs to a tracked outbound campaign call. */
export function isOutboundCall(callSid: string): boolean {
  return calls.has(callSid);
}

/** Look up a live outbound call without removing it. */
export function getOutboundCall(callSid: string): OutboundCall | undefined {
  return calls.get(callSid);
}

/** Remove and return an outbound call (used when it reaches a terminal state). */
export function takeOutboundCall(callSid: string): OutboundCall | undefined {
  const entry = calls.get(callSid);
  if (entry) calls.delete(callSid);
  return entry;
}

/** How many outbound calls are currently in flight (for the concurrency cap). */
export function liveOutboundCount(): number {
  return calls.size;
}

/**
 * Drop outbound calls older than maxAgeMs whose terminal status callback never
 * arrived (call never connected, callback lost, etc.) so a single lost callback
 * can't block the concurrency slot forever. Returns the pruned entries so the
 * worker can mark their contacts failed.
 */
export function pruneStaleOutboundCalls(maxAgeMs: number, now: number = Date.now()): OutboundCall[] {
  const stale: OutboundCall[] = [];
  for (const entry of calls.values()) {
    if (now - entry.startedAtMs >= maxAgeMs) stale.push(entry);
  }
  for (const entry of stale) {
    calls.delete(entry.callSid);
    logger.warn("Pruned stale outbound call (no terminal status callback)", {
      callSid: entry.callSid,
      contactId: entry.contactId,
      campaignId: entry.campaignId,
    });
  }
  return stale;
}

/** Clear all tracked outbound calls (test isolation / graceful shutdown). */
export function clearOutboundCalls(): void {
  calls.clear();
}
