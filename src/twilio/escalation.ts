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
export async function escalateTwilioCall(callSid: string): Promise<void> {
  const { escalationNumber } = (await resolveEffectiveConfig()).twilio;
  const client = await getTwilioClient();
  if (!client) {
    logger.error("Cannot escalate Twilio call: no Twilio REST credentials for tenant", {
      callSid,
    });
    return;
  }

  const response = new Twiml.VoiceResponse();
  if (escalationNumber && escalationNumber.trim() !== "") {
    response.dial({}, escalationNumber.trim());
    logger.info("Escalating Twilio call to human", { callSid, escalationNumber });
  } else {
    // No number to dial: apologize and hang up rather than leaving dead air.
    logger.error(
      "Twilio escalation requested but no escalation_number configured; apologizing and hanging up",
      { callSid }
    );
    response.say(
      "I'm sorry, I'm unable to connect you to a specialist right now. Please call back later."
    );
    response.hangup();
  }

  try {
    await client.calls(callSid).update({ twiml: response.toString() });
  } catch (err) {
    logger.error("Failed to redirect Twilio call for escalation", {
      callSid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
