import {
  resolveEffectiveConfig,
  twilioStatusCallbackUrl,
  twilioVoiceOutboundWebhookUrl,
} from "../config";
import { logger } from "../logger";
import { BOT_ID, loadRemoteConfig } from "../db/remoteConfig";
import { roleAllows } from "../roles";
import { isWithinTextingWindow } from "../sms/smsCompliance";
import { isPhoneOptedOut } from "../sms/smsQueries";
import { getTwilioClient } from "../twilio/client";
import type { Twilio } from "twilio";
import {
  claimPendingContacts,
  completeCampaign,
  countPendingContacts,
  getRunningCampaigns,
  setContactCallOutcome,
  setContactStatus,
  type CampaignContactRow,
  type CampaignRow,
  type ContactStatus,
} from "./campaignQueries";
import { pacePerTick } from "./rvmWorker";
import {
  liveOutboundCount,
  pruneStaleOutboundCalls,
  registerOutboundCall,
  takeOutboundCall,
} from "./outboundState";

/**
 * Outbound-calling campaign worker (PR B, spec §4).
 *
 * A ~60s poller (same shape as the RVM worker) that, for THIS tenant's running
 * `outbound_calls` campaigns, paces Twilio dials honoring pace_per_hour, skips
 * outside quiet hours (8am–9pm bot timezone), skips opted-out numbers, and dials at
 * most ONE live call at a time. Gated to the `outbound_calls` role, read fresh per
 * tick so a dashboard role/credential change applies without a redeploy. Nothing
 * here ever throws to the interval — one bad contact/campaign can't kill the tick.
 *
 * Each dial uses Twilio machine detection: the /webhooks/twilio/voice-outbound TwiML
 * hangs up on an answering machine (RVM handles voicemails) and bridges a human to
 * the same Realtime pipeline as inbound. The contact's terminal status is applied
 * from the Twilio status callback (see finalizeOutboundCall).
 */

/** Default tick period; overridable for tests via startOutboundWorker(intervalMs). */
export const OUTBOUND_TICK_MS = 60_000;

/** At most one live outbound call at a time (spec §4: max 1 concurrent). */
export const MAX_CONCURRENT_OUTBOUND = 1;

/**
 * A dialed call with no terminal status callback after this long is presumed lost;
 * it's pruned so it never blocks the single concurrency slot, and its contact is
 * marked failed. Generous enough to outlast a long live conversation.
 */
export const STALE_CALL_MS = 10 * 60 * 1000;

export interface OutboundDialContext {
  client: Twilio;
  /** This tenant's Twilio number (E.164) placed as the caller ID. */
  fromNumber: string;
  /** Existing Twilio status callback URL (call-row backstop + contact finalize). */
  statusCallbackUrl: string;
}

/**
 * Map a Twilio CallStatus (from the status callback) to a campaign_contacts terminal
 * status + a short outcome reason. A completed call is the only success; every other
 * terminal status (no-answer/busy/failed/canceled/…) is a failure with the raw Twilio
 * status as the reason. Pure + exported for unit testing.
 */
export function mapCallStatusToContact(
  callStatus: string
): { status: ContactStatus; outcome: string } {
  const s = (callStatus ?? "").trim().toLowerCase();
  if (s === "completed") return { status: "completed", outcome: "completed" };
  return { status: "failed", outcome: s === "" ? "unknown" : s };
}

/**
 * Finalize a live outbound call from its Twilio status callback: remove it from the
 * registry (freeing the concurrency slot) and write the mapped terminal status +
 * outcome + Call SID onto its campaign_contacts row. No-op when the CallSid isn't a
 * tracked outbound call (already finalized, machine-hung-up, or inbound). Never
 * throws — failure-tolerant like the rest of the worker.
 */
export async function finalizeOutboundCall(callSid: string, callStatus: string): Promise<void> {
  const entry = takeOutboundCall(callSid);
  if (!entry) return;
  const { status, outcome } = mapCallStatusToContact(callStatus);
  await setContactCallOutcome(entry.contactId, status, outcome, callSid);
  logger.info("Outbound call finalized from Twilio status callback", {
    botId: BOT_ID,
    campaignId: entry.campaignId,
    contactId: entry.contactId,
    callStatus,
    contactStatus: status,
  });
}

/**
 * Dial ONE contact via Twilio, registering the call so it holds the concurrency slot
 * and can be finalized from the status callback. Returns true when the dial was
 * accepted. On any failure the contact is marked failed and false is returned — one
 * bad dial never aborts the batch.
 */
export async function placeOutboundCall(
  campaign: CampaignRow,
  contact: CampaignContactRow,
  ctx: OutboundDialContext
): Promise<boolean> {
  const url = twilioVoiceOutboundWebhookUrl(contact.id);
  if (!url) {
    logger.error("Outbound dial skipped: PUBLIC_BASE_URL unset (no voice-outbound URL)", {
      botId: BOT_ID,
      campaignId: campaign.id,
      contactId: contact.id,
    });
    await setContactCallOutcome(contact.id, "failed", "no_public_base_url", null);
    return false;
  }
  try {
    const call = await ctx.client.calls.create({
      to: contact.phone_number,
      from: ctx.fromNumber,
      url,
      // Answering-machine detection: the webhook hangs up on a machine (RVM covers
      // voicemails) and bridges a human to the Realtime pipeline.
      machineDetection: "Enable",
      statusCallback: ctx.statusCallbackUrl,
      statusCallbackEvent: ["completed"],
    });
    const callSid = call?.sid;
    if (!callSid) {
      // No SID means we can't track/finalize the call — treat as a failed dial.
      await setContactCallOutcome(contact.id, "failed", "no_call_sid", null);
      return false;
    }
    registerOutboundCall(callSid, contact.id, campaign.id);
    logger.info("Outbound call dialed", {
      botId: BOT_ID,
      campaignId: campaign.id,
      contactId: contact.id,
      callSid,
    });
    return true;
  } catch (err) {
    await setContactCallOutcome(
      contact.id,
      "failed",
      err instanceof Error ? err.message : String(err),
      null
    );
    logger.error("Outbound dial threw; contact marked failed", {
      botId: BOT_ID,
      campaignId: campaign.id,
      contactId: contact.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Process ONE running outbound_calls campaign for this tick: honoring the single
 * concurrency slot, claim a paced batch and dial each (skipping opted-out numbers),
 * completing the campaign when no pending contacts remain. Assumes quiet-hours/role/
 * credential gates already passed. Never throws.
 */
export async function processOutboundCampaign(
  campaign: CampaignRow,
  ctx: OutboundDialContext
): Promise<void> {
  // Concurrency cap: never claim/dial while a call is still live (spec §4).
  const slots = MAX_CONCURRENT_OUTBOUND - liveOutboundCount();
  if (slots <= 0) return;

  const batchSize = Math.min(pacePerTick(campaign.pace_per_hour), slots);
  const batch = await claimPendingContacts(campaign.id, batchSize);
  if (batch.length === 0) {
    // Nothing claimable. If truly no pending remain, the campaign is done.
    const remaining = await countPendingContacts(campaign.id);
    if (remaining === 0) {
      logger.info("Outbound campaign complete: no pending contacts remain", {
        botId: BOT_ID,
        campaignId: campaign.id,
      });
      await completeCampaign(campaign.id);
    }
    return;
  }

  for (const contact of batch) {
    try {
      // Compliance: never dial a number that opted out of texting on this bot.
      if (await isPhoneOptedOut(contact.phone_number)) {
        await setContactStatus(contact.id, "skipped", "opted_out");
        logger.info("Outbound dial skipped: number opted out", {
          botId: BOT_ID,
          campaignId: campaign.id,
          contactId: contact.id,
        });
        continue;
      }
      const dialed = await placeOutboundCall(campaign, contact, ctx);
      // Once a call is live it owns the single slot; stop dialing the rest of the
      // batch this tick (a later tick picks up once the slot frees).
      if (dialed && liveOutboundCount() >= MAX_CONCURRENT_OUTBOUND) break;
    } catch (err) {
      // Belt-and-suspenders: placeOutboundCall already swallows its own errors.
      await setContactCallOutcome(
        contact.id,
        "failed",
        err instanceof Error ? err.message : String(err),
        null
      );
      logger.error("Outbound contact processing threw; marked failed", {
        botId: BOT_ID,
        campaignId: campaign.id,
        contactId: contact.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * One worker tick: reload config, enforce the role gate + quiet hours + credentials,
 * prune stale calls, then process every running outbound_calls campaign. Exported
 * for unit testing. Never throws.
 */
export async function runOutboundTick(now: Date = new Date()): Promise<void> {
  try {
    await loadRemoteConfig();
    const cfg = await resolveEffectiveConfig();

    // Role gate (fresh per tick): outbound calling runs only for outbound_calls.
    if (!roleAllows(cfg.botRole, "campaign_calls")) return;

    // Quiet hours: skip the whole tick outside 8am–9pm in the bot's timezone.
    if (!isWithinTextingWindow(now, cfg.text.timezone)) {
      logger.info("Outbound tick skipped: outside quiet-hours window", {
        botId: BOT_ID,
        timezone: cfg.text.timezone,
      });
      return;
    }

    // Free the concurrency slot (and fail the contact) for any call whose terminal
    // status callback never arrived, so a lost callback can't wedge the campaign.
    const stale = pruneStaleOutboundCalls(STALE_CALL_MS, now.getTime());
    for (const entry of stale) {
      await setContactCallOutcome(entry.contactId, "failed", "timeout_no_status", entry.callSid);
    }

    // A tenant Twilio number is required as the caller ID; without it we can't dial.
    if (!cfg.twilio.number) {
      logger.warn("Outbound tick skipped: no Twilio number configured for tenant", {
        botId: BOT_ID,
      });
      return;
    }

    // Public callback URLs must be configured for the bridge + status finalize.
    const statusCallbackUrl = twilioStatusCallbackUrl();
    if (!statusCallbackUrl) {
      logger.error("Outbound tick skipped: PUBLIC_BASE_URL unset (no status callback URL)");
      return;
    }

    // Tenant Twilio REST client (null when credentials missing → never log secrets).
    const client = await getTwilioClient();
    if (!client) {
      logger.warn("Outbound tick skipped: Twilio credentials missing for tenant", {
        botId: BOT_ID,
      });
      return;
    }

    const ctx: OutboundDialContext = {
      client,
      fromNumber: cfg.twilio.number,
      statusCallbackUrl,
    };

    const campaigns = await getRunningCampaigns("outbound_calls");
    for (const campaign of campaigns) {
      await processOutboundCampaign(campaign, ctx);
    }
  } catch (err) {
    logger.error("Outbound tick failed unexpectedly", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Start the outbound-calling poller. Non-fatal by contract (runOutboundTick swallows
 * its own errors) and self-guarded against overlapping runs if a tick outlasts the
 * interval. Returns the timer handle; unref'd so it never keeps the process alive.
 */
export function startOutboundWorker(
  intervalMs: number = OUTBOUND_TICK_MS
): ReturnType<typeof setInterval> {
  timer = setInterval(async () => {
    if (running) return; // previous tick still in flight; skip this beat
    running = true;
    try {
      await runOutboundTick();
    } finally {
      running = false;
    }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  logger.info("Outbound calling worker started", { intervalMs });
  return timer;
}

/** Stop the poller (used in tests / graceful shutdown). */
export function stopOutboundWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
