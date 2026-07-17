import {
  resolveEffectiveConfig,
  twilioStatusCallbackUrl,
  twilioVoiceWebhookUrl,
} from "../config";
import { logger } from "../logger";
import { BOT_ID } from "../db/remoteConfig";
import { getTwilioClient } from "./client";

/**
 * Idempotently point THIS tenant's Twilio number at our webhooks on startup.
 *
 * Using only this tenant's api_credentials (via getTwilioClient), look up the
 * IncomingPhoneNumber whose phoneNumber === bot_config.twilio_number and set its
 * VoiceUrl to POST {PUBLIC_BASE_URL}/webhooks/twilio/voice and its status callback
 * to {PUBLIC_BASE_URL}/webhooks/twilio/status. We match by exact phoneNumber and
 * NEVER create or touch any other number, so we can never modify another tenant's
 * number. If the number isn't in the account we log an error (not fatal) — we do
 * not create numbers. Everything is wrapped so startup never crashes if the Twilio
 * API is slow or down.
 */
export async function provisionTwilioNumber(): Promise<void> {
  try {
    const voiceUrl = twilioVoiceWebhookUrl();
    const statusCallback = twilioStatusCallbackUrl();
    if (!voiceUrl) {
      logger.warn("Skipping Twilio number provisioning: PUBLIC_BASE_URL unset (no webhook URL)");
      return;
    }

    const { number } = (await resolveEffectiveConfig()).twilio;
    if (!number || number.trim() === "") {
      logger.warn("Skipping Twilio number provisioning: no twilio_number assigned for this tenant", {
        botId: BOT_ID,
      });
      return;
    }

    const client = await getTwilioClient();
    if (!client) {
      logger.error("Skipping Twilio number provisioning: no Twilio REST credentials for tenant", {
        botId: BOT_ID,
      });
      return;
    }

    // Scope strictly to THIS tenant's number — never enumerate/modify others.
    const matches = await client.incomingPhoneNumbers.list({ phoneNumber: number, limit: 20 });
    const target = matches.find((n) => n.phoneNumber === number);
    if (!target) {
      logger.error(
        "Twilio number not found in this tenant's account; not creating it. " +
          "Provision the number in Twilio and assign it as twilio_number.",
        { botId: BOT_ID, number }
      );
      return;
    }

    await client.incomingPhoneNumbers(target.sid).update({
      voiceUrl,
      voiceMethod: "POST",
      ...(statusCallback ? { statusCallback, statusCallbackMethod: "POST" } : {}),
    });
    logger.info("Twilio number provisioned (VoiceUrl + status callback set)", {
      botId: BOT_ID,
      number,
      voiceUrl,
      statusCallback: statusCallback || null,
    });
  } catch (err) {
    // Never fatal: a slow/down Twilio API must not crash startup.
    logger.error("Twilio number provisioning failed (service still running)", {
      botId: BOT_ID,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
