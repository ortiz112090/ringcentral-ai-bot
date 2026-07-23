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
 * True when `now` falls within the allowed texting window in the given IANA timezone.
 * The window bounds default to the 8am–9pm constants so existing callers/tests are
 * unchanged, but are per-bot configurable (bot_config.text_window_start_hour /
 * text_window_end_hour). Used to gate BOT-INITIATED texts (missed-call / web-lead
 * openers, campaign sends); replies to an inbound text are always allowed.
 *
 * Uses Intl to read the wall-clock hour in the target timezone without pulling in a
 * date library. Fails OPEN (returns true) rather than mute the bot when either:
 *   - the timezone is invalid, or
 *   - the configured window is invalid (non-integer, out of 0–23, or start >= end;
 *     wrapping past midnight is not supported) — a misconfig must not silently mute.
 */
export function isWithinTextingWindow(
  now: Date,
  timeZone: string,
  startHour: number = QUIET_HOURS_START,
  endHour: number = QUIET_HOURS_END
): boolean {
  if (
    !Number.isInteger(startHour) ||
    !Number.isInteger(endHour) ||
    startHour < 0 ||
    startHour > 23 ||
    endHour < 0 ||
    endHour > 23 ||
    startHour >= endHour
  ) {
    return true; // invalid window → fail open
  }
  const hour = hourInTimeZone(now, timeZone);
  if (hour === null) return true; // unknown tz → don't block
  return hour >= startHour && hour < endHour;
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
