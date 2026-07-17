import { twiml as Twiml } from "twilio";
import { resolveEffectiveConfig } from "../config";
import { logger } from "../logger";
import { getTwilioClient } from "./client";

/**
 * Escalate a live Twilio call to a human by redirecting it via the REST API.
 *
 * Twilio cannot blind-transfer to a RingCentral extension, so escalation redirects
 * the in-progress call to fresh TwiML:
 *   - escalation_number set  → <Dial>{escalation_number}</Dial>
 *   - escalation_number unset → polite <Say> apology + <Hangup> (logged as error)
 *
 * Wired into audioBridge via StartBridgeOptions.onEscalate (see mediaStream.ts), so
 * the model's escalate_to_human tool and any bridge error route through here for
 * Twilio calls. Never throws — the bridge logs on failure and still wraps up.
 */
/**
 * Pure TwiML for a live-call escalation redirect. With an escalation number, dial
 * it with callerId set to this tenant's Twilio number so the human sees a
 * consistent caller ID. Without one, apologize, offer a callback, and hang up
 * (the bridge marks the call outcome 'escalated' regardless).
 */
export function buildEscalationTwiml(
  escalationNumber: string | undefined,
  twilioNumber: string | undefined
): string {
  const response = new Twiml.VoiceResponse();
  if (escalationNumber && escalationNumber.trim() !== "") {
    const callerId = twilioNumber && twilioNumber.trim() !== "" ? twilioNumber.trim() : undefined;
    response.dial(callerId ? { callerId } : {}, escalationNumber.trim());
  } else {
    // No number to dial: apologize, offer a callback, and hang up (no dead air).
    response.say(
      "I'm sorry, I'm unable to connect you to a specialist right now. " +
        "Someone from our team will call you back as soon as possible. Goodbye."
    );
    response.hangup();
  }
  return response.toString();
}

export async function escalateTwilioCall(callSid: string): Promise<void> {
  const { escalationNumber, number } = (await resolveEffectiveConfig()).twilio;
  const client = await getTwilioClient();
  if (!client) {
    logger.error("Cannot escalate Twilio call: no Twilio REST credentials for tenant", {
      callSid,
    });
    return;
  }

  if (escalationNumber && escalationNumber.trim() !== "") {
    logger.info("Escalating Twilio call to human", { callSid, escalationNumber });
  } else {
    logger.error(
      "Twilio escalation requested but no escalation_number configured; " +
        "offering a callback and hanging up (outcome marked escalated)",
      { callSid }
    );
  }

  try {
    await client.calls(callSid).update({ twiml: buildEscalationTwiml(escalationNumber, number) });
  } catch (err) {
    logger.error("Failed to redirect Twilio call for escalation", {
      callSid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
