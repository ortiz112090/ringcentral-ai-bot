import type { LeadRecord } from "../db/types";
import type { LeadFieldRow } from "../db/queries";
import type { TextStageRow } from "./smsQueries";

/**
 * Builds the OpenAI Chat Completions system prompt for the SMS texting bot.
 *
 * Mirrors the voice engine's brains (buildRealtimeInstructions) but adapted for
 * text: the SAME script-discipline rules — stage lines written VERBATIM, react
 * briefly with a VARIED acknowledgment ("Awesome!"/"Great!"/"Perfect!"/"Mhm, no
 * problem!", never twice in a row), field-completion enforcement (ask only for
 * missing pieces), and the BACK-ON-SCRIPT rule. Differences from voice: hard SMS
 * length cap (max 2–3 short sentences, no markdown), no read-back-and-confirm
 * latency dance, no spoken-delivery section. The Text Flow comes from text_stages
 * (never script_stages); we fall back to a compact hardcoded SR22 SMS script when
 * the dashboard has no active stages.
 */

/** Stage types that make up the linear script flow, in render order. */
const FLOW_TYPES = ["opener", "qualify", "data_collection", "quote"] as const;

/** Substitute the dashboard authoring placeholders with runtime values. */
function substitute(text: string, leadName: string, agentName: string): string {
  return text
    .replace(/\(Client's Name\)/g, leadName)
    .replace(/\(Agent Name\)/g, agentName);
}

/** Render stages as "## {title}\n{script_text}" blocks in order. */
function renderStages(
  stages: TextStageRow[],
  leadName: string,
  agentName: string
): string {
  return stages
    .map((s) => {
      const title = (s.title ?? s.stage_key ?? "").trim();
      const body = substitute((s.script_text ?? "").trim(), leadName, agentName);
      return `## ${title}\n${body}`;
    })
    .join("\n\n");
}

/** Build the DB-driven script sections from active text_stages (empty groups omitted). */
function buildDbScriptSections(
  stages: TextStageRow[],
  leadName: string,
  agentName: string
): string {
  const byType = (type: string) => stages.filter((s) => s.stage_type === type);
  const sections: string[] = [];

  const flow = stages.filter((s) =>
    (FLOW_TYPES as readonly string[]).includes(s.stage_type)
  );
  if (flow.length > 0) {
    sections.push(`# SCRIPT FLOW\n${renderStages(flow, leadName, agentName)}`);
  }

  const closes = byType("close");
  if (closes.length > 0) {
    const attempts = closes
      .map((s, i) => {
        const title = (s.title ?? s.stage_key ?? "").trim();
        const body = substitute((s.script_text ?? "").trim(), leadName, agentName);
        return `${i + 1}. ${title}: ${body}`;
      })
      .join("\n");
    sections.push(
      `# CLOSING DISCIPLINE — work these closes IN ORDER before giving up:\n${attempts}`
    );
  }

  const objections = byType("objection");
  if (objections.length > 0) {
    sections.push(`# OBJECTIONS\n${renderStages(objections, leadName, agentName)}`);
  }

  const fallbacks = byType("fallback");
  if (fallbacks.length > 0) {
    sections.push(`# FALLBACKS\n${renderStages(fallbacks, leadName, agentName)}`);
  }

  return sections.join("\n\n");
}

/** Compact hardcoded SR22 SMS script, used when the dashboard has no text_stages. */
function hardcodedSmsScript(agentName: string): string {
  return `# SCRIPT FLOW
## Opener
"Hi {name}, this is ${agentName}. I saw you were looking into getting an SR22 filed — has anyone helped you with that yet?"
- If NO: "No problem, I can take care of that for you. How soon do you need it filed?"
- If YES: reference their existing quote and move to collecting quote info.

## Quote Collection
Collect ZIP, DATE OF BIRTH, DRIVER'S LICENSE NUMBER, and the license STATE — one at a time, one short question per text.

## Present Quote
Once you have the info: "Great — let me pull the best rate for you." Then present the Progressive PIF option; if they push back on price, offer the Dairyland monthly option.

## Close
Ask if that works for them today. If they hesitate, offer a split payment or to shop other carriers, then offer to book a callback.`;
}

/**
 * Build the SMS system prompt. `leadFields` (dashboard-configured) name the info to
 * collect so the prompt and the capture_lead_info tool schema stay aligned.
 */
export function buildSmsSystemPrompt(input: {
  lead: LeadRecord | null;
  stages: TextStageRow[];
  leadFields: LeadFieldRow[];
  agentName: string;
  businessName: string;
}): string {
  const { lead, agentName, businessName } = input;
  const activeStages = (input.stages ?? []).filter((s) => !!s && !!s.stage_type);
  const leadName = lead?.first_name?.trim() ? lead.first_name.trim() : "{name}";

  const knownLead = lead
    ? `Known lead on file — Name: ${lead.first_name ?? "unknown"}, ZIP: ${
        lead.zip_code ?? "unknown"
      }, carrier context: ${lead.carrier ?? "none"}, status: ${
        lead.status ?? "new"
      }. Do NOT re-ask fields you already have; use the name naturally.`
    : "This lead is not yet in the system; treat as a fresh SR22 lead.";

  const fieldsToCollect =
    input.leadFields && input.leadFields.length > 0
      ? input.leadFields
          .map((f) => (f.label && f.label.trim() !== "" ? f.label.trim() : f.field_key))
          .filter((s) => s && s.trim() !== "")
          .join(", ")
      : "first and last name, ZIP code, date of birth, driver's license number, license state";

  const scriptSections =
    activeStages.length > 0
      ? buildDbScriptSections(activeStages, leadName, agentName)
      : hardcodedSmsScript(agentName);

  return `You are ${agentName}, a friendly, confident licensed auto-insurance agent at ${businessName}, working a lead over SMS TEXT MESSAGES. The lead was recently on the website trying to file an SR22. Run the Text Flow script below to move them toward a quote and close, or escalate to a human.

${knownLead}

# HARD RULES (never violate)
1. TEXT LENGTH: keep every reply to at most 2–3 SHORT sentences. No markdown, no bullet lists, no emojis, no stage directions — this is a text message.
2. NEVER run, offer to run, or reference an MVR (Motor Vehicle Record) check.
3. Collect quote info ONE piece at a time (${fieldsToCollect}). Ask only for what you still need.
4. FIELD COMPLETION: only save a field with capture_lead_info once it is COMPLETE and valid — address needs street, city, and zip; date of birth needs month, day, and year; license number needs the full number with NO dashes. If an answer is partial, acknowledge what you got and ask ONLY for the missing piece — never re-ask something they already gave.
5. STAGE GATING: for each data-collection stage, do NOT move on to the next stage until the current stage's info has been captured with capture_lead_info and accepted. If an answer is missing, partial, or invalid, ask again for exactly the missing piece before continuing. Never skip a data-collection stage.
6. After saving data with capture_lead_info, do NOT announce that you saved/logged it — just continue with the next scripted line.
7. Only quote dollar amounts you are actually given; with no real number, give a clearly-framed rough estimate and offer to book a callback.
8. If the lead asks for a human, asks a legal/complex/complaint question, or you're unsure — call escalate_to_human after a brief handoff line.
9. If the lead clearly asks to stop being texted or opt out, call mark_opted_out.

# SCRIPT ADHERENCE
Script lines are written to be sent EXACTLY. When a stage's text is a message line, send it word-for-word — do not rephrase, shorten, embellish, or swap in synonyms. Only two exceptions: (1) fill placeholders like the lead's name naturally, and (2) when a stage's text is an instruction to you (e.g. "Offer the manager discount.") rather than a message line, write ONE short sentence that does exactly that.
Follow the stages in order. Do NOT invent your own questions, offers, or products not in the script. React BRIEFLY to what the lead just said before the next stage line so it doesn't feel robotic, but the stage line itself stays verbatim.
BACK ON SCRIPT: if the lead asks something the script doesn't cover, answer briefly in one sentence, then steer right back to the current stage's question.
When you capture a piece of info and give a short acknowledgment before the next stage line, VARY the acknowledgment word — pick from this set and NEVER use the same one twice in a row: "Awesome!", "Great!", "Perfect!", "Mhm, no problem!". This variety applies ONLY to that brief acknowledgment, never to the scripted line, which stays verbatim.

${scriptSections}

# TOOLS — call these to track state (never mention them in the text):
- capture_lead_info: call whenever you learn any lead detail (name, ZIP, home address, email, start timeline, DOB, license number/state, quoted amounts, carrier).
- escalate_to_human: call when an escalation trigger fires, after a brief handoff line.
- mark_opted_out: call only if the lead clearly asks to stop being texted.

Respond with ONLY the text message to send the lead — nothing else.`;
}
