import { dropCowboyStatusCallbackUrl, resolveEffectiveConfig } from "../config";
import { logger } from "../logger";
import { BOT_ID, loadRemoteConfig } from "../db/remoteConfig";
import { roleAllows } from "../roles";
import { isWithinTextingWindow } from "../sms/smsCompliance";
import { isPhoneOptedOut } from "../sms/smsQueries";
import {
  claimPendingContacts,
  completeCampaign,
  countPendingContacts,
  getRunningCampaigns,
  setContactStatus,
  type CampaignRow,
} from "./campaignQueries";
import { buildRvmPayload, sendRvm } from "./dropcowboy";

/**
 * Drop Cowboy ringless-voicemail worker.
 *
 * A ~60s poller (same style as the startup pollers) that, for THIS tenant's running
 * `voicemail_drops` campaigns, paces RVM drops honoring pace_per_hour, skips outside
 * quiet hours (8am–9pm bot timezone), skips opted-out numbers, and marks each
 * contact sent/failed/skipped. Gated to the answer_and_followup role, read fresh per
 * tick so a dashboard role/credential change applies without a redeploy. Nothing
 * here ever throws to the interval — one bad contact/campaign can't kill the tick.
 */

/** Default tick period; overridable for tests via startRvmWorker(intervalMs). */
export const RVM_TICK_MS = 60_000;

/**
 * Contacts to claim per tick to honor pace_per_hour: ceil(pace / 60), minimum 1 so a
 * running campaign always makes forward progress. Non-positive/NaN pace → 1.
 */
export function pacePerTick(pacePerHour: number): number {
  if (!Number.isFinite(pacePerHour) || pacePerHour <= 0) return 1;
  return Math.max(1, Math.ceil(pacePerHour / 60));
}

/**
 * Process ONE running voicemail_drops campaign for this tick: claim a paced batch,
 * drop each (skipping opted-out numbers), and complete the campaign when no pending
 * contacts remain. Assumes quiet-hours/role/credential gates already passed. Never
 * throws — a single contact failing is isolated so the rest of the batch proceeds.
 */
export async function processRvmCampaign(
  campaign: CampaignRow,
  ctx: {
    credentials: { teamId: string | undefined; secret: string | undefined; brandId: string | undefined };
    forwardingNumber: string | undefined;
    callbackUrl: string;
  }
): Promise<void> {
  // A voicemail_drops campaign needs a recording GUID; without it every drop would
  // fail, so skip the whole campaign this tick (leave it running for the operator).
  if (!campaign.dc_recording_id || campaign.dc_recording_id.trim() === "") {
    logger.warn("Skipping RVM campaign: no dc_recording_id set", {
      botId: BOT_ID,
      campaignId: campaign.id,
    });
    return;
  }

  const batch = await claimPendingContacts(campaign.id, pacePerTick(campaign.pace_per_hour));
  if (batch.length === 0) {
    // Nothing pending was claimable. If truly no pending remain, the campaign is done.
    const remaining = await countPendingContacts(campaign.id);
    if (remaining === 0) {
      logger.info("RVM campaign complete: no pending contacts remain", {
        botId: BOT_ID,
        campaignId: campaign.id,
      });
      await completeCampaign(campaign.id);
    }
    return;
  }

  for (const contact of batch) {
    try {
      // Compliance: never drop on a number that opted out of texting on this bot.
      if (await isPhoneOptedOut(contact.phone_number)) {
        await setContactStatus(contact.id, "skipped", "opted_out");
        logger.info("RVM drop skipped: number opted out", {
          botId: BOT_ID,
          campaignId: campaign.id,
          contactId: contact.id,
        });
        continue;
      }

      const payload = buildRvmPayload({
        credentials: ctx.credentials,
        contactId: contact.id,
        phoneNumber: contact.phone_number,
        recordingId: campaign.dc_recording_id,
        forwardingNumber: ctx.forwardingNumber,
        callbackUrl: ctx.callbackUrl,
      });
      const result = await sendRvm(payload);
      if (result.ok) {
        await setContactStatus(contact.id, "sent");
      } else {
        // outcome = provider response text (setContactStatus truncates to a safe length).
        await setContactStatus(contact.id, "failed", result.body);
        logger.warn("RVM drop rejected by Drop Cowboy", {
          botId: BOT_ID,
          campaignId: campaign.id,
          contactId: contact.id,
          status: result.status,
        });
      }
    } catch (err) {
      // Never let one contact kill the batch; record and move on.
      await setContactStatus(
        contact.id,
        "failed",
        err instanceof Error ? err.message : String(err)
      );
      logger.error("RVM drop threw unexpectedly; contact marked failed", {
        botId: BOT_ID,
        campaignId: campaign.id,
        contactId: contact.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * One worker tick: reload config, enforce the role gate + quiet hours, then process
 * every running voicemail_drops campaign. Exported for unit testing. Never throws.
 */
export async function runRvmTick(now: Date = new Date()): Promise<void> {
  try {
    await loadRemoteConfig();
    const cfg = await resolveEffectiveConfig();

    // Role gate (fresh per tick): RVM campaigns run only for answer_and_followup.
    if (!roleAllows(cfg.botRole, "campaign_rvm")) return;

    // Quiet hours: skip the whole tick outside 8am–9pm in the bot's timezone.
    if (!isWithinTextingWindow(now, cfg.text.timezone)) {
      logger.info("RVM tick skipped: outside quiet-hours window", {
        botId: BOT_ID,
        timezone: cfg.text.timezone,
      });
      return;
    }

    // Credentials required to send; without them, do nothing (never log secrets).
    if (!cfg.dropcowboy.teamId || !cfg.dropcowboy.secret) {
      logger.warn("RVM tick skipped: Drop Cowboy credentials missing for tenant", {
        botId: BOT_ID,
      });
      return;
    }

    const callbackUrl = dropCowboyStatusCallbackUrl();
    if (!callbackUrl) {
      logger.error("RVM tick skipped: PUBLIC_BASE_URL unset (no callback URL)");
      return;
    }

    const campaigns = await getRunningCampaigns("voicemail_drops");
    for (const campaign of campaigns) {
      await processRvmCampaign(campaign, {
        credentials: cfg.dropcowboy,
        forwardingNumber: cfg.twilio.number,
        callbackUrl,
      });
    }
  } catch (err) {
    logger.error("RVM tick failed unexpectedly", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Start the RVM poller. Non-fatal by contract (runRvmTick swallows its own errors)
 * and self-guarded against overlapping runs if a tick outlasts the interval. Returns
 * the timer handle; unref'd so it never keeps the process alive on its own.
 */
export function startRvmWorker(intervalMs: number = RVM_TICK_MS): ReturnType<typeof setInterval> {
  timer = setInterval(async () => {
    if (running) return; // previous tick still in flight; skip this beat
    running = true;
    try {
      await runRvmTick();
    } finally {
      running = false;
    }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  logger.info("Drop Cowboy RVM worker started", { intervalMs });
  return timer;
}

/** Stop the poller (used in tests / graceful shutdown). */
export function stopRvmWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
