/**
 * Centralized bot-role gating (pure — exported for unit testing).
 *
 * Every tenant has a `bot_role` (bot_config.bot_role, default 'answer_calls')
 * that decides which pipelines are active for that deployment. The role is read
 * FRESH per event from resolveEffectiveConfig() so a dashboard change takes effect
 * on the next call/message/tick with no redeploy. All gating funnels through
 * roleAllows() so the matrix lives in exactly one place.
 *
 * Role → feature matrix (see spec §1):
 *   answer_calls        — inbound voice only.
 *   outbound_calls      — campaign dialer; inbound voice STILL answers (callbacks
 *                         from people it dialed must reach the bot).
 *   answer_and_followup — inbound voice + RVM voicemail-drop follow-up campaigns.
 *   texting             — SMS bot only.
 */

export type BotRole =
  | "answer_calls"
  | "outbound_calls"
  | "answer_and_followup"
  | "texting";

/** A gated capability. */
export type Feature =
  /** The inbound voice webhook answers calls with the Realtime pipeline. */
  | "voice_inbound"
  /** The SMS pipeline (inbound replies + bot-initiated openers). */
  | "sms"
  /** The outbound-calling campaign runner (PR B). */
  | "campaign_calls"
  /** The Drop Cowboy ringless-voicemail campaign runner (PR A). */
  | "campaign_rvm"
  /** The text-outreach campaign runner (PR E). */
  | "campaign_texts";

/** The default role when bot_config.bot_role is unset/blank/unknown. */
export const DEFAULT_BOT_ROLE: BotRole = "answer_calls";

const VALID_ROLES: ReadonlySet<string> = new Set<BotRole>([
  "answer_calls",
  "outbound_calls",
  "answer_and_followup",
  "texting",
]);

/**
 * Coerce a raw config value into a valid BotRole. Trims + lower-cases; an
 * unknown/blank/non-string value falls back to the safe default ('answer_calls')
 * so a typo in the dashboard never silently disables the inbound line.
 */
export function normalizeRole(value: unknown): BotRole {
  if (typeof value !== "string") return DEFAULT_BOT_ROLE;
  const normalized = value.trim().toLowerCase();
  return VALID_ROLES.has(normalized) ? (normalized as BotRole) : DEFAULT_BOT_ROLE;
}

/**
 * The single source of truth for role gating. Returns true when `role` is allowed
 * to run `feature`. Voice-inbound is allowed for every voice role (so outbound and
 * follow-up bots remain reachable for callbacks); SMS only for texting; each
 * campaign runner only for its owning role.
 */
export function roleAllows(role: BotRole, feature: Feature): boolean {
  switch (feature) {
    case "voice_inbound":
      return (
        role === "answer_calls" ||
        role === "outbound_calls" ||
        role === "answer_and_followup"
      );
    case "sms":
      return role === "texting";
    case "campaign_calls":
      return role === "outbound_calls";
    case "campaign_rvm":
      return role === "answer_and_followup";
    case "campaign_texts":
      return role === "texting";
    default:
      return false;
  }
}
