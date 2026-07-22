import { resolveEffectiveConfig } from "../config";
import { logger } from "../logger";
import { rcPost } from "../ringcentral/client";
import { BOT_ID } from "../db/remoteConfig";

/**
 * Outbound SMS over RingCentral, the RC-channel counterpart to the Twilio sender in
 * smsSend.ts. Uses the existing authenticated RingCentral client (JWT server-to-
 * server auth, DB-first credentials) and this tenant's rc_sms_number as the From.
 *
 *   POST /restapi/v1.0/account/~/extension/{id or ~}/sms
 *   { from: { phoneNumber: rcSmsNumber }, to: [{ phoneNumber }], text }
 *
 * When cfg.text.rcSmsExtensionId is set (non-blank) the bot sends AS that extension
 * (an admin token sends on behalf of it); otherwise it keeps the authenticated
 * extension ('~'). The From stays the tenant's rc_sms_number either way.
 *
 * Never throws: a missing number or an RC API failure is logged and returned as a
 * falsy result so the calling SMS pipeline (webhook/reply) stays non-fatal, exactly
 * like the Twilio path.
 */
export interface RcSendResult {
  sent: boolean;
  /** Why the send was skipped/failed (no_number / error). Absent on success. */
  reason?: string;
}

/**
 * The /account/~/extension/{ext}/sms endpoint the bot POSTs to. `ext` is the chosen
 * rc_sms_extension_id when set, else '~' (the authenticated extension).
 */
function smsEndpoint(extensionId: string | undefined): string {
  const ext = extensionId && extensionId.trim() !== "" ? extensionId.trim() : "~";
  return `/restapi/v1.0/account/~/extension/${ext}/sms`;
}

/** RC error signature meaning the app lacks account-level permission to act as another extension. */
function isInsufficientPermissions(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("cmn-408") || msg.includes("insufficient permission");
}

export async function sendRcSms(input: {
  to: string;
  text: string;
}): Promise<RcSendResult> {
  const { text } = await resolveEffectiveConfig();
  const from = text.rcSmsNumber;
  if (!from || from.trim() === "") {
    logger.error("Cannot send RingCentral SMS: no rc_sms_number configured for tenant", {
      botId: BOT_ID,
    });
    return { sent: false, reason: "no_number" };
  }

  try {
    await rcPost(smsEndpoint(text.rcSmsExtensionId), {
      from: { phoneNumber: from.trim() },
      to: [{ phoneNumber: input.to }],
      text: input.text,
    });
  } catch (err) {
    if (text.rcSmsExtensionId && isInsufficientPermissions(err)) {
      logger.error(
        "RingCentral SMS send rejected: the RingCentral app needs account-level SMS " +
          "permission to send as another user (extension). Grant it or clear " +
          "rc_sms_extension_id to send as the authenticated extension.",
        { botId: BOT_ID, rcSmsExtensionId: text.rcSmsExtensionId }
      );
    } else {
      logger.error("Failed to send SMS via RingCentral", {
        botId: BOT_ID,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { sent: false, reason: "error" };
  }
  return { sent: true };
}
