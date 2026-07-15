import { config } from "../config";
import { logger } from "../logger";
import { buildSystemPrompt } from "./systemPrompt";
import { openai } from "./openaiClient";
import { retrieveRelevantLessons } from "./retrieval";
import { LeadRecord } from "../db/types";

/** The structured decision the model returns each turn. */
export interface BotDecision {
  say: string;
  stage: string;
  close_attempts: number;
  escalate: boolean;
  outcome: "closed_pif" | "closed_installment" | "escalated" | "follow_up_needed" | null;
  lead_updates: Partial<
    Pick<
      LeadRecord,
      | "first_name"
      | "zip_code"
      | "date_of_birth"
      | "license_number"
      | "quote_amount_pif"
      | "quote_amount_monthly"
      | "carrier"
    >
  >;
}

export type ChatTurn = { role: "user" | "assistant"; content: string };

const FALLBACK_ESCALATION: BotDecision = {
  say: "Let me get you over to one of our specialists who can take great care of you — one moment.",
  stage: "escalation",
  close_attempts: 0,
  escalate: true,
  outcome: "escalated",
  lead_updates: {},
};

/**
 * Runs one turn of the conversation through the OpenAI chat model and parses the JSON
 * control block. This is the NON-realtime text path (used for the SMS script); live
 * phone calls now go through the Realtime speech-to-speech engine instead.
 * On ANY error (API failure, unparseable output) we fall back to a safe escalation so
 * the caller is always handed to a human rather than left hanging.
 */
export async function getBotDecision(
  lead: LeadRecord | null,
  history: ChatTurn[]
): Promise<BotDecision> {
  try {
    // Retrieval-based learning: pull approved lessons relevant to the caller's latest
    // line and inject them additively into the system prompt. Fully safe — on any
    // failure this returns an empty string and the core script is used unchanged.
    const lastCallerLine = [...history].reverse().find((t) => t.role === "user")?.content ?? "";
    const lessons = await retrieveRelevantLessons(lastCallerLine);

    const response = await openai.chat.completions.create({
      model: config.openai.chatModel,
      max_tokens: 500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildSystemPrompt(lead, lessons) },
        ...history.map((t) => ({
          role: (t.role === "user" ? "user" : "assistant") as "user" | "assistant",
          content: t.content,
        })),
      ],
    });

    return parseDecision(response.choices[0]?.message?.content ?? "");
  } catch (err) {
    logger.error("OpenAI chat call failed; falling back to escalation", {
      error: err instanceof Error ? err.message : String(err),
    });
    return FALLBACK_ESCALATION;
  }
}

/** Extracts and validates the JSON control block from the model's text output. */
export function parseDecision(raw: string): BotDecision {
  try {
    // The model is told to return pure JSON, but be tolerant of accidental fencing/prose.
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("no JSON object found");
    }
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Partial<BotDecision>;

    if (typeof parsed.say !== "string" || parsed.say.trim() === "") {
      throw new Error("missing 'say'");
    }

    return {
      say: parsed.say,
      stage: typeof parsed.stage === "string" ? parsed.stage : "opener",
      close_attempts:
        typeof parsed.close_attempts === "number" ? parsed.close_attempts : 0,
      escalate: parsed.escalate === true,
      outcome: parsed.outcome ?? null,
      lead_updates:
        parsed.lead_updates && typeof parsed.lead_updates === "object"
          ? parsed.lead_updates
          : {},
    };
  } catch (err) {
    logger.warn("Failed to parse bot decision; escalating", {
      error: err instanceof Error ? err.message : String(err),
      raw: raw.slice(0, 300),
    });
    return FALLBACK_ESCALATION;
  }
}
