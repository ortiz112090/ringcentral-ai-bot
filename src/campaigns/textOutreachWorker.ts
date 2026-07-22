import { resolveEffectiveConfig } from "../config";
import { logger } from "../logger";
import { BOT_ID, loadRemoteConfig } from "../db/remoteConfig";
import { roleAllows } from "../roles";
import { isWithinTextingWindow } from "../sms/smsCompliance";
import {
  createConversation,
  findConversationByPhone,
  getActiveOutreachTemplates,
  isPhoneDeclined,
  isPhoneOptedOut,
  type TextChannel,
  type TextConversationRow,
  type TextOutreachTemplateRow,
} from "../sms/smsQueries";
import { sendSms, withOptOutSuffix } from "../sms/smsSend";
import {
  claimPendingContacts,
  completeCampaign,
  countPendingContacts,
  getNewestAttemptedAt,
  getRunningCampaigns,
  setContactStatus,
  type CampaignContactRow,
  type CampaignRow,
} from "./campaignQueries";
import { pacePerTick } from "./rvmWorker";

/**
 * Text-outreach worker.
 *
 * A ~60s poller (same style as rvmWorker) that, for THIS tenant's running
 * `text_outreach` campaigns, mass-texts a RANDOMIZED, personalized first message to
 * paced batches of pending contacts. Replies then flow through the EXISTING inbound
 * SMS pipeline (smsEngine + webhooks) with the bot's Text Flow script — no new code
 * on the back-and-forth side.
 *
 * Gated to the `texting` role via the 'campaign_texts' feature, read FRESH per tick
 * so a dashboard role/credential change applies with no redeploy. Never throws to the
 * interval. Operator config gaps (no channel / no active templates) leave contacts
 * PENDING with a logged warning — they are never marked failed.
 */

/** Default tick period; overridable for tests via startTextOutreachWorker(intervalMs). */
export const TEXT_OUTREACH_TICK_MS = 60_000;

/**
 * Replace {first_name} (and the {firstname} variant), case-insensitively, with the
 * contact's first name — falling back to 'there' when it's absent/blank.
 */
export function personalizeTemplate(
  templateText: string,
  firstName: string | null | undefined
): string {
  const name = (firstName ?? "").trim() !== "" ? (firstName as string).trim() : "there";
  return (templateText ?? "").replace(/\{first_?name\}/gi, name);
}

/**
 * Build the outbound FIRST message: personalize, then append the mandatory
 * ' Reply STOP to opt out.' notice unless the template already tells the recipient
 * how to STOP (reuses withOptOutSuffix, so no double-append).
 */
export function buildFirstMessage(
  templateText: string,
  firstName: string | null | undefined
): string {
  return withOptOutSuffix(personalizeTemplate(templateText, firstName));
}

/**
 * Pick one template uniformly at random. `rng` is injectable for deterministic tests;
 * defaults to Math.random. Assumes a non-empty list (callers gate on that upstream).
 */
export function pickTemplate<T>(templates: T[], rng: () => number = Math.random): T {
  const idx = Math.min(templates.length - 1, Math.floor(rng() * templates.length));
  return templates[idx];
}

/**
 * The send channel for this tenant this tick: RingCentral is PREFERRED when an
 * rc_sms_number is set, else Twilio when a text_number is set, else null (no usable
 * channel — the worker leaves everything pending).
 */
export function pickChannel(cfg: {
  text: { rcSmsNumber: string | undefined; number: string | undefined };
}): TextChannel | null {
  if ((cfg.text.rcSmsNumber ?? "").trim() !== "") return "ringcentral";
  if ((cfg.text.number ?? "").trim() !== "") return "twilio";
  return null;
}

/**
 * Upsert the (bot, phone) conversation for an outreach send. If a thread already
 * exists we REUSE it as-is (never resetting stage/captured data); otherwise we create
 * one on the chosen send channel. Returns null only when creation failed (DB error),
 * so the caller can leave the contact pending rather than text without a tracked
 * thread.
 */
async function upsertOutreachConversation(
  phone: string,
  channel: TextChannel
): Promise<TextConversationRow | null> {
  const existing = await findConversationByPhone(phone);
  if (existing) return existing;
  return createConversation({ phone_number: phone, trigger: "web_lead", channel });
}

/**
 * Process ONE running text_outreach campaign for this tick: claim a batch and send
 * each contact its randomized first message. Assumes the role/quiet-hours gates and
 * the tenant channel + template gates already passed (channel + templates are passed
 * in). Never throws — one bad contact is isolated so the rest proceed. A per-contact
 * send/config problem leaves that contact PENDING (retried next tick), never failed.
 *
 * Send spacing:
 *   - send_delay_minutes set (>=1): claim AT MOST ONE contact, and only when the
 *     campaign's newest attempt (sent/skipped/failed — opt-outs count) is older than
 *     the delay, or there are no attempts yet. Otherwise send nothing this tick.
 *   - null: the existing pace_per_hour batch behavior, completely unchanged.
 */
export async function processTextOutreachCampaign(
  campaign: CampaignRow,
  ctx: { channel: TextChannel; templates: TextOutreachTemplateRow[] },
  now: Date = new Date()
): Promise<void> {
  const delay = campaign.send_delay_minutes;
  const delayed = typeof delay === "number" && delay >= 1;

  if (delayed) {
    // Spacing gate: hold this tick if the newest attempt is more recent than the delay.
    const newest = await getNewestAttemptedAt(campaign.id);
    if (newest && now.getTime() - newest.getTime() < delay * 60_000) return;
  }

  const limit = delayed ? 1 : pacePerTick(campaign.pace_per_hour);
  const batch = await claimPendingContacts(campaign.id, limit);
  if (batch.length === 0) {
    const remaining = await countPendingContacts(campaign.id);
    if (remaining === 0) {
      logger.info("Text-outreach campaign complete: no pending contacts remain", {
        botId: BOT_ID,
        campaignId: campaign.id,
      });
      await completeCampaign(campaign.id);
    }
    return;
  }

  // Plain sequential sends within a tick — SMS is fast, no parallel fan-out.
  for (const contact of batch) {
    await sendToContact(campaign, contact, ctx);
  }
}

/** Send one contact's first message, mapping the result to a contact status. */
async function sendToContact(
  campaign: CampaignRow,
  contact: CampaignContactRow,
  ctx: { channel: TextChannel; templates: TextOutreachTemplateRow[] }
): Promise<void> {
  try {
    // Compliance: never text a number that opted out on this bot.
    if (await isPhoneOptedOut(contact.phone_number)) {
      await setContactStatus(contact.id, "skipped", "opted_out");
      logger.info("Text-outreach skipped: number opted out", {
        botId: BOT_ID,
        campaignId: campaign.id,
        contactId: contact.id,
      });
      return;
    }

    // Interest gate: never re-text a number that already declined on this bot
    // (mirrors the opt-out skip; a decline is terminal, same as opted_out).
    if (await isPhoneDeclined(contact.phone_number)) {
      await setContactStatus(contact.id, "skipped", "declined");
      logger.info("Text-outreach skipped: number declined", {
        botId: BOT_ID,
        campaignId: campaign.id,
        contactId: contact.id,
      });
      return;
    }

    const template = pickTemplate(ctx.templates);
    const body = buildFirstMessage(template.template_text, contact.first_name);

    const conversation = await upsertOutreachConversation(contact.phone_number, ctx.channel);
    if (!conversation) {
      // Couldn't open/find a thread (DB error) — leave pending for a later tick.
      await setContactStatus(contact.id, "pending");
      logger.warn("Text-outreach left pending: could not upsert conversation", {
        botId: BOT_ID,
        campaignId: campaign.id,
        contactId: contact.id,
      });
      return;
    }

    // Channel-routed send (records the outbound text_messages row). The STOP notice
    // is already appended above, so we don't ask sendSms to add it again.
    const result = await sendSms({ conversation, body, firstBotInitiated: false });
    if (result.sent) {
      await setContactStatus(contact.id, "sent", "delivered_attempt");
      return;
    }

    // Send didn't go out (config gap / transient). Never fail an outreach contact —
    // leave it pending so a fixed config retries it next tick.
    await setContactStatus(contact.id, "pending");
    logger.warn("Text-outreach left pending: send not delivered", {
      botId: BOT_ID,
      campaignId: campaign.id,
      contactId: contact.id,
      reason: result.reason,
    });
  } catch (err) {
    // Never let one contact kill the batch, and never mark an outreach contact
    // failed — reset to pending so it's retried.
    await setContactStatus(contact.id, "pending");
    logger.error("Text-outreach send threw; contact left pending", {
      botId: BOT_ID,
      campaignId: campaign.id,
      contactId: contact.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * One worker tick: reload config, enforce the role gate + quiet hours + tenant
 * channel/template gates, then process every running text_outreach campaign.
 * Exported for unit testing. Never throws.
 */
export async function runTextOutreachTick(now: Date = new Date()): Promise<void> {
  try {
    await loadRemoteConfig();
    const cfg = await resolveEffectiveConfig();

    // Role gate (fresh per tick): text-outreach runs only for the texting role.
    if (!roleAllows(cfg.botRole, "campaign_texts")) return;

    // Quiet hours: skip the whole tick outside 8am–9pm in the bot's timezone.
    if (!isWithinTextingWindow(now, cfg.text.timezone)) {
      logger.info("Text-outreach tick skipped: outside quiet-hours window", {
        botId: BOT_ID,
        timezone: cfg.text.timezone,
      });
      return;
    }

    // Channel gate: without a usable RC/Twilio number we can't send. Leave all
    // contacts pending (we claim nothing) and log — operator config gap, not a fail.
    const channel = pickChannel(cfg);
    if (!channel) {
      logger.warn("Text-outreach tick skipped: no usable SMS channel configured", {
        botId: BOT_ID,
      });
      return;
    }

    // Template gate: no active templates → nothing to send. Same treatment as no
    // channel: leave contacts pending and log a warning.
    const templates = await getActiveOutreachTemplates();
    if (templates.length === 0) {
      logger.warn("Text-outreach tick skipped: no active templates for tenant", {
        botId: BOT_ID,
      });
      return;
    }

    const campaigns = await getRunningCampaigns("text_outreach");
    for (const campaign of campaigns) {
      await processTextOutreachCampaign(campaign, { channel, templates }, now);
    }
  } catch (err) {
    logger.error("Text-outreach tick failed unexpectedly", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Start the text-outreach poller. Non-fatal by contract (runTextOutreachTick swallows
 * its own errors) and self-guarded against overlapping runs if a tick outlasts the
 * interval. Returns the timer handle; unref'd so it never keeps the process alive.
 */
export function startTextOutreachWorker(
  intervalMs: number = TEXT_OUTREACH_TICK_MS
): ReturnType<typeof setInterval> {
  timer = setInterval(async () => {
    if (running) return; // previous tick still in flight; skip this beat
    running = true;
    try {
      await runTextOutreachTick();
    } finally {
      running = false;
    }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  logger.info("Text-outreach worker started", { intervalMs });
  return timer;
}

/** Stop the poller (used in tests / graceful shutdown). */
export function stopTextOutreachWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
