import { resolveEffectiveConfig } from "../config";
import { logger } from "../logger";
import { rcPost } from "../ringcentral/client";
import { BOT_ID } from "../db/remoteConfig";

/**
 * Outbound SMS over RingCentral, the RC-channel counterpart to the Twilio sender in
 * smsSend.ts. Uses the existing authenticated RingCentral client (JWT server-to-
 * server auth, DB-first credentials) and this tenant's rc_sms_number as the From.
 *
 *   POST /restapi/v1.0/account/~/extension/~/sms
 *   { from: { phoneNumber: rcSmsNumber }, to: [{ phoneNumber }], text }
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

const ACCOUNT_EXTENSION_SMS = "/restapi/v1.0/account/~/extension/~/sms";

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
    await rcPost(ACCOUNT_EXTENSION_SMS, {
      from: { phoneNumber: from.trim() },
      to: [{ phoneNumber: input.to }],
      text: input.text,
    });
  } catch (err) {
    logger.error("Failed to send SMS via RingCentral", {
      botId: BOT_ID,
      error: err instanceof Error ? err.message : String(err),
    });
    return { sent: false, reason: "error" };
  }
  return { sent: true };
}
