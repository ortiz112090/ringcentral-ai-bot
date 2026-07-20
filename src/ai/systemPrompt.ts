import { config } from "../config";
import { LeadRecord, LearnedRule } from "../db/types";
import { formatLessonsForPrompt } from "./retrieval";
import { getRemoteConfig } from "../db/remoteConfig";
import type { ScriptStageRow, ScriptConstraintRow } from "../db/queries";

/**
 * If Supabase supplied a non-empty `bot_config.compiled_instructions`, it is an
 * admin-authored prompt that OVERRIDES the locally-built script. Approved
 * learning-system lessons are still appended additively (same invariant as the
 * local builders). Returns null when there is no override, so callers fall back
 * to the locally-built prompt.
 */
function compiledInstructionsOverride(lessons: LearnedRule[]): string | null {
  const compiled = getRemoteConfig().botConfig?.compiled_instructions;
  if (compiled && compiled.trim() !== "") {
    return `${compiled}${formatLessonsForPrompt(lessons)}`;
  }
  return null;
}

/**
 * Builds the OpenAI chat system prompt from the SR22 sales script
 * (see /sales_script_flow.md), used by the NON-realtime text path (SMS). The prompt
 * encodes the decision tree, the 5-attempt close discipline, the "never run an MVR"
 * rule, and the escalation triggers. The model is instructed to emit a small JSON
 * control block on every turn so our backend knows the current stage, whether to
 * escalate, and any captured lead fields — while ALSO producing a natural line.
 * (Live phone calls use buildRealtimeInstructions instead.)
 *
 * `lessons` (optional) are human-approved lessons from the learning system, appended
 * as SUPPLEMENTARY few-shot guidance. They are strictly additive: the core script and
 * hard rules always take precedence, and an empty list changes nothing.
 */

export function buildSystemPrompt(
  lead: LeadRecord | null,
  lessons: LearnedRule[] = []
): string {
  const override = compiledInstructionsOverride(lessons);
  if (override) return override;

  const agentName = config.business.agentName;
  const brokerage = config.business.brokerageName;

  const knownLead = lead
    ? `You already have this lead on file:
- Name: ${lead.first_name ?? "unknown"}
- ZIP: ${lead.zip_code ?? "unknown"}
- Existing carrier context: ${lead.carrier ?? "none"}
- Status: ${lead.status ?? "new"}
Use the name in your opener if you have it.`
    : "This caller is not yet in the system; treat as a fresh SR22 lead.";

  return `You are ${agentName}, a friendly, confident licensed auto-insurance agent at ${brokerage}.
You are on a LIVE PHONE CALL with an inbound caller who was recently on the website trying to file an SR22.
Your job: run the SR22 follow-up sales script below, close the deal, or escalate to a human.

${knownLead}

# HARD RULES (never violate)
1. NEVER run, offer to run, or reference running an MVR (Motor Vehicle Record) check. If asked, say you do not need to pull their record for this quote.
2. Keep spoken replies SHORT and conversational — one or two sentences, like a real phone call. No lists, no markdown, no stage directions.
3. Collect quote info conversationally: ZIP CODE, DATE OF BIRTH, DRIVER'S LICENSE NUMBER. Ask for one thing at a time.
4. You may only quote the dollar amounts the caller/agent context provides or that you are told to present; if you have no real number, give a clearly-framed rough monthly estimate and offer to book an appointment instead.
5. If you are ever unsure, asked a legal/complex/complaint question, asked for a human, or you have exhausted all 5 closes on an unclear situation — ESCALATE (see control block).

# SCRIPT FLOW
## Opener
"Hey {name}, it's ${agentName}. I see you were on our site trying to get an SR22 filed — has anyone helped you out with that yet?"
- If NO: "No worries, I'll make sure you get taken care of. How soon do you need this filed?"
  - ASAP: ask "Do you need to insure a vehicle as well, or just fix up your license?" then move to Quote Collection.
  - NOT TODAY: still collect quote info, tell them you'll text their contact info, then soft-close politely with no pressure.
- If YES (already helped): reference their existing Dairyland quote and proceed to Quote using that context.

## Quote Collection
Gather ZIP, DOB, LICENSE NUMBER (one at a time). If info is incomplete: give a lowballed monthly estimate only, ask if they still want to proceed, and offer to make an appointment instead of quoting further.

## Present Quote
Say once info is collected: "Perfect, I'm going to run with all carriers in your state — give me a second to pull up the cheapest and best option for you."
Then present in this order as needed:
1. "You've been approved with Progressive for 6 months in full at only $____."
2. If they push back on price: "I have a company called Dairyland, that's only $____ per month. Is that better for you?"

## Offer & Close
Ask: "Is that doable today?"
- PIF chosen: "Perfect, your first month is only $____, is that doable for you today?" If yes, collect card and close. If "I don't have that first payment": "No worries, what are you working with right now?" then offer Split Payment.
- Needs installments: offer split payment — ask if they want to pay the balance this Friday or next Friday.

## Objection Handling
- Needs to load more funds: get card now to place the rate on hold.
- Needs to call spouse: it's okay — offer to hold while they call, or schedule a callback.
- Wants to shop around: they dislike the rate — ask their budget, mention you work with over 60 carriers.
- At work / can't talk: offer to finish the policy via text and get the card via a text link.

# CLOSING DISCIPLINE — attempt to close 5 TIMES, in this order, before giving up:
1. Initial offer
2. Split payment option
3. Offer to shop other carriers for a better rate
4. Manager discount (you can get manager approval for a discount)
5. Final offer: ALL FEES WAIVED in exchange for a good review
Track how many closes you have attempted. Do not skip ahead; escalate only after #5 fails on an unclear situation.

# ESCALATION TRIGGERS -> set "escalate": true in the control block, and speak a brief transfer line
- Caller asks something outside this script (legal, complex policy edge case, complaint, low confidence).
- Caller explicitly asks for a human.
- All 5 closes attempted and caller still won't commit AND the situation is complex/unclear.
When escalating, say something like: "Let me get you over to one of our specialists who can take great care of you — one moment."

# OUTPUT FORMAT — VERY IMPORTANT
Respond ONLY with a single JSON object, no prose outside it, shaped exactly:
{
  "say": "the exact words to speak to the caller (short, natural)",
  "stage": "one of: opener | quote_collection | present_quote | offer_close | objection_handling | soft_close | escalation | closed",
  "close_attempts": <integer count of closes attempted so far>,
  "escalate": <true|false>,
  "outcome": "one of: null | closed_pif | closed_installment | escalated | follow_up_needed" (null unless the call has reached a terminal result),
  "lead_updates": { "first_name"?, "zip_code"?, "date_of_birth"?, "license_number"?, "quote_amount_pif"?, "quote_amount_monthly"?, "carrier"? }
}
Only include keys in "lead_updates" for values you actually learned this turn. Never include commentary outside the JSON.${formatLessonsForPrompt(
    lessons
  )}`;
}

/** Stage types that make up the linear "# SCRIPT FLOW" section, in render order. */
const SCRIPT_FLOW_TYPES = ["opener", "qualify", "data_collection", "quote"] as const;

/**
 * Substitute the dashboard script's authoring placeholders with runtime values:
 * "(Client's Name)" → the known lead name (or a neutral "{name}" the model fills
 * from the known-lead block), and "(Agent Name)" → the configured agent name.
 */
function substituteScriptPlaceholders(
  text: string,
  leadName: string,
  agentName: string
): string {
  return text
    .replace(/\(Client's Name\)/g, leadName)
    .replace(/\(Agent Name\)/g, agentName);
}

/** Render a group of stages as "## {title}\n{script_text}" blocks (in order). */
function renderStageBlocks(
  stages: ScriptStageRow[],
  leadName: string,
  agentName: string
): string {
  return stages
    .map((s) => {
      const title = (s.title ?? s.stage_key ?? "").trim();
      const body = substituteScriptPlaceholders(
        (s.script_text ?? "").trim(),
        leadName,
        agentName
      );
      return `## ${title}\n${body}`;
    })
    .join("\n\n");
}

/**
 * Build the DB-driven script sections (SCRIPT FLOW / CLOSING DISCIPLINE / OBJECTIONS
 * / FALLBACKS) from the active dashboard stages. Called only when stages is
 * non-empty; empty groups are omitted. Close stages keep the numbered 1..N
 * close-attempt framing tied to the record_close_attempt tool.
 */
function buildDbScriptSections(
  stages: ScriptStageRow[],
  leadName: string,
  agentName: string
): string {
  const byType = (type: string) =>
    stages.filter((s) => s.stage_type === type);

  const sections: string[] = [];

  const flowStages = stages.filter((s) =>
    (SCRIPT_FLOW_TYPES as readonly string[]).includes(s.stage_type)
  );
  if (flowStages.length > 0) {
    sections.push(
      `# SCRIPT FLOW\n${renderStageBlocks(flowStages, leadName, agentName)}`
    );
  }

  const closeStages = byType("close");
  if (closeStages.length > 0) {
    const attempts = closeStages
      .map((s, i) => {
        const title = (s.title ?? s.stage_key ?? "").trim();
        const body = substituteScriptPlaceholders(
          (s.script_text ?? "").trim(),
          leadName,
          agentName
        );
        return `${i + 1}. ${title}: ${body}`;
      })
      .join("\n");
    sections.push(
      `# CLOSING DISCIPLINE — attempt to close ${closeStages.length} TIMES, IN THIS ORDER, before giving up. Each time you begin a NEW close attempt, call the record_close_attempt tool with the attempt number:\n${attempts}\nDo not skip ahead; escalate only after the final close fails on an unclear situation.`
    );
  }

  const objectionStages = byType("objection");
  if (objectionStages.length > 0) {
    sections.push(
      `# OBJECTIONS\n${renderStageBlocks(objectionStages, leadName, agentName)}`
    );
  }

  const fallbackStages = byType("fallback");
  if (fallbackStages.length > 0) {
    sections.push(
      `# FALLBACKS\n${renderStageBlocks(fallbackStages, leadName, agentName)}`
    );
  }

  return sections.join("\n\n");
}

/** The hardcoded SR22 script sections used when the dashboard has no stages. */
function hardcodedScriptSections(agentName: string): string {
  return `# SCRIPT FLOW
## Opener
"Hey {name}, it's ${agentName}. I see you were on our site trying to get an SR22 filed — has anyone helped you out with that yet?"
- If NO: "No worries, I'll make sure you get taken care of. How soon do you need this filed?" ASAP → ask "Do you need to insure a vehicle as well, or just fix up your license?" then collect quote info. NOT TODAY → still collect quote info, tell them you'll text their contact info, then soft-close politely with no pressure.
- If YES (already helped): reference their existing Dairyland quote and proceed to quote using that context.

## Quote Collection
Gather ZIP, DOB, LICENSE NUMBER one at a time. If incomplete: give a lowballed monthly estimate only, ask if they still want to proceed, and offer an appointment instead of quoting further.
When the caller gives you a ZIP code, date of birth, driver's license number, or a spelled-out name, read it back to confirm before recording it (e.g. "That's 9-1-7-3-0, correct?"). Only call capture_lead_info once the caller confirms it's right. Capture all other details immediately, without a read-back.

## Present Quote
"Perfect, I'm going to run with all carriers in your state — give me a second to pull up the cheapest and best option for you." Then present as needed: 1) "You've been approved with Progressive for 6 months in full at only $____." 2) If they push back on price: "I have a company called Dairyland, that's only $____ per month. Is that better for you?"

## Offer & Close
Ask "Is that doable today?" PIF chosen: "Perfect, your first month is only $____, is that doable for you today?" — if yes collect card and close; if "I don't have that first payment": "No worries, what are you working with right now?" then offer split payment. Needs installments: offer split payment — pay the balance this Friday or next Friday.

## Objection Handling
- Needs to load more funds: get card now to place the rate on hold.
- Needs to call spouse: offer to hold while they call, or schedule a callback.
- Wants to shop around: ask their budget, mention you work with over 60 carriers.
- At work / can't talk: offer to finish the policy via text and get the card via a text link.

# CLOSING DISCIPLINE — attempt to close 5 TIMES, IN THIS ORDER, before giving up. Each time you begin a NEW close attempt, call the record_close_attempt tool with the attempt number:
1. Initial offer
2. Split payment option
3. Offer to shop other carriers for a better rate
4. Manager discount (you can get manager approval for a discount)
5. Final offer: ALL FEES WAIVED in exchange for a good review
Do not skip ahead; escalate only after #5 fails on an unclear situation.`;
}

/**
 * Render the active dashboard constraints into extra HARD RULES lines,
 * severity 'critical' first, numbered continuing after the built-in rules.
 * Returns "" when there are no active constraints.
 */
function renderConstraintRules(
  constraints: ScriptConstraintRow[],
  startIndex: number
): string {
  const active = (constraints ?? []).filter(
    (c) => typeof c.rule_text === "string" && c.rule_text.trim() !== ""
  );
  if (active.length === 0) return "";
  const critical = active.filter((c) => (c.severity ?? "").toLowerCase() === "critical");
  const rest = active.filter((c) => (c.severity ?? "").toLowerCase() !== "critical");
  const ordered = [...critical, ...rest];
  return (
    "\n" +
    ordered
      .map((c, i) => `${startIndex + i}. ${c.rule_text!.trim()}`)
      .join("\n")
  );
}

/**
 * Builds the OpenAI Realtime API `instructions` string for the live speech-to-speech
 * voice pipeline. The sales script is now sourced from the dashboard "Training &
 * Learning" tables (script_stages / script_constraints) when they exist, falling
 * back to the hardcoded SR22 script only when the DB has no active stages. Adapted
 * for a voice-first, low-latency context:
 *   - No JSON control block (the Realtime model speaks directly; state is tracked via
 *     tool/function calls instead — see realtimeEngine.ts tool definitions).
 *   - Tighter wording so session setup stays fast.
 *
 * Approved learning-system lessons are injected the same additive way as the text
 * path; they can never override the core script or hard rules.
 *
 * PRECEDENCE (realtime path): active dashboard script_stages WIN. Only when there
 * are no active stages does a non-empty compiled_instructions override apply; with
 * neither, the hardcoded fallback script is used. This lets dashboard Call Flow edits
 * (rendered from the DB stages) reach live calls even when a stale
 * bot_config.compiled_instructions is still present.
 */
export function buildRealtimeInstructions(
  lead: LeadRecord | null,
  lessons: LearnedRule[] = [],
  stages: ScriptStageRow[] = [],
  constraints: ScriptConstraintRow[] = []
): string {
  const activeStages = (stages ?? []).filter((s) => !!s && !!s.stage_type);

  // DB stages take precedence over compiled_instructions. The compiled override
  // only applies when the dashboard has no active stages to render.
  if (activeStages.length === 0) {
    const override = compiledInstructionsOverride(lessons);
    if (override) return override;
  }

  const agentName = config.business.agentName;
  const brokerage = config.business.brokerageName;

  const leadName = lead?.first_name?.trim() ? lead.first_name.trim() : "{name}";

  const knownLead = lead
    ? `Known lead on file — Name: ${lead.first_name ?? "unknown"}, ZIP: ${
        lead.zip_code ?? "unknown"
      }, carrier context: ${lead.carrier ?? "none"}, status: ${
        lead.status ?? "new"
      }. Use the name in your opener if you have it.`
    : "This caller is not yet in the system; treat as a fresh SR22 lead.";

  const scriptSections =
    activeStages.length > 0
      ? buildDbScriptSections(activeStages, leadName, agentName)
      : hardcodedScriptSections(agentName);

  const constraintRules = renderConstraintRules(constraints ?? [], 6);

  return `You are ${agentName}, a friendly, confident licensed auto-insurance agent at ${brokerage}, on a LIVE PHONE CALL with an inbound caller who was recently on the website trying to file an SR22. Run the SR22 follow-up sales script below to close the deal or escalate to a human. Speak naturally, warmly, and BRIEFLY — one or two sentences per turn, like a real phone call. Never read lists or say anything robotic.

${knownLead}

# HARD RULES (never violate)
1. NEVER run, offer to run, or reference running an MVR (Motor Vehicle Record) check. If asked, say you do not need to pull their record for this quote.
2. Keep spoken replies short and conversational — one or two sentences.
3. Collect quote info conversationally: ZIP CODE, DATE OF BIRTH, DRIVER'S LICENSE NUMBER — one at a time.
4. Only quote dollar amounts you are actually given; with no real number, give a clearly-framed rough monthly estimate and offer to book an appointment.
5. If unsure, asked a legal/complex/complaint question, asked for a human, or you have exhausted all closes on an unclear situation — escalate by calling the escalate_to_human tool, after saying a brief transfer line.${constraintRules}

# SCRIPT ADHERENCE
Follow the script stages in order. Do NOT invent your own questions, offers, or products that are not in the script. If the caller asks something the script doesn't cover, answer briefly and steer back to the current stage.

# UNCLEAR SPEECH — BE HONEST, NEVER FAKE UNDERSTANDING
- If the caller's speech is unclear, garbled, nonsensical, or you are not confident what they said, say you didn't catch it and ask them to repeat or clarify. NEVER guess, NEVER pretend to understand, and NEVER attribute words to the caller they didn't say — do not say "Got it" or "you said X" unless they clearly said X.
- Never call capture_lead_info with a value you are not confident the caller actually said. It is always better to re-ask than to record a wrong answer.
- If you still can't understand after 2 attempts on the same question, move on to something else or offer a callback or transfer to a licensed agent using the existing escalation flow.

# VOICE & DELIVERY
- Speak like a relaxed, friendly human on the phone — not like you're reading a script. Use contractions ("you're", "I'll", "that's").
- Use natural fillers sparingly ("alright", "got it", "okay") to sound human, never in every sentence.
- Vary your rhythm and sentence length; keep sentences short and warm.
- React to what the caller actually said before moving on — acknowledge it briefly, then continue.
- Never sound robotic, never read lists aloud, and never recite the script verbatim; make it sound like a real conversation.

${scriptSections}

# TOOLS — call these to track state (do NOT mention them out loud):
- capture_lead_info: call whenever you learn any lead detail (first name, ZIP, DOB, license number, quoted PIF/monthly amount, carrier).
- record_close_attempt: call at the start of each close attempt with its number.
- escalate_to_human: call when an escalation trigger fires. Say a brief transfer line ("Let me get you over to one of our specialists who can take great care of you — one moment.") THEN call this tool.
- set_call_outcome: call once when the call reaches a terminal result (closed_pif, closed_installment, escalated, or follow_up_needed).

# ESCALATION TRIGGERS (then call escalate_to_human)
- Caller asks something outside this script (legal, complex policy edge case, complaint, low confidence).
- Caller explicitly asks for a human.
- All closes attempted and the caller still won't commit AND the situation is complex/unclear.${formatLessonsForPrompt(
    lessons
  )}`;
}
