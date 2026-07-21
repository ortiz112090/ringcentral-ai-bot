/**
 * SMS compliance helpers (pure — exported for unit testing). Covers the two
 * non-negotiable SMS rules: STOP/HELP keyword handling and quiet-hours for
 * bot-INITIATED texts. Opt-out ENFORCEMENT (never texting an opted_out number)
 * lives in smsSend.ts, which reads the conversation status before every send.
 */

/** Keyword class of an inbound SMS body, or null when it's an ordinary message. */
export type InboundKeyword = "stop" | "help" | null;

/** Standard carrier STOP keywords (Twilio also enforces these at its layer). */
const STOP_KEYWORDS = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
]);

/** Standard carrier HELP keywords. */
const HELP_KEYWORDS = new Set(["help", "info"]);

/**
 * Classify an inbound SMS body as a STOP, HELP, or ordinary message. Matches only
 * when the trimmed, lower-cased body is EXACTLY a keyword (carrier convention) so a
 * sentence like "please help me pick a plan" is a normal message, not a HELP ping.
 * STOP wins if a body somehow matches both.
 */
export function classifyInboundKeyword(body: string): InboundKeyword {
  const normalized = (body ?? "").trim().toLowerCase();
  if (STOP_KEYWORDS.has(normalized)) return "stop";
  if (HELP_KEYWORDS.has(normalized)) return "help";
  return null;
}

/** The bot-initiated texting window (inclusive start, exclusive end), local time. */
export const QUIET_HOURS_START = 8; // 8am
export const QUIET_HOURS_END = 21; // 9pm

/**
 * True when `now` falls within the allowed texting window (8am–9pm) in the given
 * IANA timezone. Used to gate BOT-INITIATED texts (missed-call / web-lead openers);
 * replies to an inbound text are always allowed (the user just messaged us).
 *
 * Uses Intl to read the wall-clock hour in the target timezone without pulling in a
 * date library. On an invalid timezone we fail OPEN (return true) rather than block
 * every send — a misconfigured tz should not silently mute the bot.
 */
export function isWithinTextingWindow(now: Date, timeZone: string): boolean {
  const hour = hourInTimeZone(now, timeZone);
  if (hour === null) return true; // unknown tz → don't block
  return hour >= QUIET_HOURS_START && hour < QUIET_HOURS_END;
}

/** The wall-clock hour (0–23) at `now` in `timeZone`, or null when tz is invalid. */
function hourInTimeZone(now: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hour12: false,
    }).formatToParts(now);
    const hourPart = parts.find((p) => p.type === "hour")?.value;
    if (hourPart === undefined) return null;
    // Intl may render midnight as "24" under hour12:false; normalize to 0.
    const hour = parseInt(hourPart, 10) % 24;
    return Number.isFinite(hour) ? hour : null;
  } catch {
    return null;
  }
}

/**
 * The mandatory opt-out suffix appended to the FIRST outbound message of a
 * bot-initiated conversation (missed-call / web-lead). Not needed on replies to
 * inbound texts (the user initiated and can reply STOP anytime).
 */
export const OPT_OUT_SUFFIX = "Reply STOP to opt out.";

/**
 * The HELP auto-reply: identify the business and how to stop. `businessName` is
 * bot_config.business_name (falling back to agent_name upstream).
 */
export function buildHelpReply(businessName: string): string {
  const name = businessName.trim() !== "" ? businessName.trim() : "our team";
  return `${name}: this is an automated assistant. Reply STOP to opt out at any time.`;
}
