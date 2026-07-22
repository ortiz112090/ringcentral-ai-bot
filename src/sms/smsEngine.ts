import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { logger } from "../logger";
import { getOpenAI } from "../ai/openaiClient";
import {
  buildCaptureLeadTool,
  buildLeadColumnUpdates,
  validateCapturedValues,
} from "../leads/capture";
import { upsertLead, type LeadFieldRow } from "../db/queries";
import type { LeadRecord } from "../db/types";
import { buildSmsSystemPrompt } from "./smsPrompt";
import {
  mergeConversationCapturedData,
  type TextConversationRow,
  type TextStageRow,
} from "./smsQueries";

/** One prior SMS turn, oriented for the chat model (user = inbound, assistant = outbound). */
export interface SmsChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** Result of running one SMS turn through the model + tool loop. */
export interface SmsTurnResult {
  /** The text message to send back (may be "" if the model only called tools). */
  reply: string;
  /** True when the model called escalate_to_human this turn. */
  escalate: boolean;
  /** True when the model called mark_opted_out this turn. */
  optedOut: boolean;
  /** True when the model called mark_not_interested this turn (interest gate: negative first reply). */
  declined: boolean;
  /** Validated lead keys captured this turn (already merged/persisted). */
  captured: Record<string, unknown>;
}

/** Max model round-trips (initial call + tool-result follow-ups) to avoid loops. */
const MAX_TOOL_ROUNDS = 4;

/** Safe handoff line used when the model escalates without emitting its own text. */
const ESCALATION_FALLBACK_LINE =
  "Let me connect you with one of our specialists who can help — one moment.";

/**
 * Static (non-capture) SMS tools, in Chat Completions shape. capture_lead_info is
 * built dynamically per bot and prepended. NOTE: Chat Completions nests the schema
 * under `function`, unlike the Realtime API's flat tool shape — see toChatTool.
 */
const STATIC_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "escalate_to_human",
      description:
        "Escalate this conversation to a human specialist. Send a brief handoff line first, then call this.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mark_opted_out",
      description:
        "Call ONLY when the lead clearly asks to stop being texted / opt out.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "mark_not_interested",
      description:
        "Call this when the lead's reply clearly signals they are not interested, don't need this, don't want a follow-up, or otherwise decline to proceed — but did NOT explicitly ask to stop being texted (use mark_opted_out for that instead).",
      parameters: { type: "object", properties: {} },
    },
  },
];

/** Wrap the flat (Realtime-shaped) capture tool into the Chat Completions shape. */
function toChatTool(flat: Record<string, unknown>): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: String(flat.name),
      description: typeof flat.description === "string" ? flat.description : undefined,
      parameters: (flat.parameters as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      },
    },
  };
}

/**
 * Run ONE inbound SMS turn: build the system prompt, call the chat model with the
 * capture/escalate/opt-out tools, execute any tool calls (validating + persisting
 * captured data exactly like the voice path), and loop until the model produces a
 * text reply. Never throws — on any model/API failure it returns a safe escalation
 * so the lead is handed to a human rather than left hanging.
 */
export async function runSmsTurn(input: {
  conversation: TextConversationRow;
  lead: LeadRecord | null;
  stages: TextStageRow[];
  leadFields: LeadFieldRow[];
  history: SmsChatTurn[];
  model: string;
  agentName: string;
  businessName: string;
}): Promise<SmsTurnResult> {
  const result: SmsTurnResult = {
    reply: "",
    escalate: false,
    optedOut: false,
    declined: false,
    captured: {},
  };

  try {
    const openai = await getOpenAI();
    const captureTool = toChatTool(buildCaptureLeadTool(input.leadFields));
    const tools: ChatCompletionTool[] = [captureTool, ...STATIC_TOOLS];

    const systemPrompt = buildSmsSystemPrompt({
      lead: input.lead,
      stages: input.stages,
      leadFields: input.leadFields,
      agentName: input.agentName,
      businessName: input.businessName,
    });

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...input.history.map((t) => ({ role: t.role, content: t.content })),
    ];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await openai.chat.completions.create({
        model: input.model,
        temperature: 0.4,
        max_tokens: 300,
        messages,
        tools,
        tool_choice: "auto",
      });

      const choice = response.choices[0]?.message;
      if (!choice) break;

      const toolCalls = choice.tool_calls ?? [];
      if (toolCalls.length === 0) {
        result.reply = (choice.content ?? "").trim();
        break;
      }

      // Echo the assistant's tool-call message back, then answer each tool call so
      // the model can produce its final text on the next round.
      messages.push(choice);
      for (const call of toolCalls) {
        if (call.type !== "function") continue;
        const output = await executeToolCall(call.function.name, call.function.arguments, input, result);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(output),
        });
      }
    }

    // If the model escalated but produced no line, use a safe handoff line.
    if (result.escalate && result.reply === "") {
      result.reply = ESCALATION_FALLBACK_LINE;
    }
    return result;
  } catch (err) {
    logger.error("SMS turn failed; escalating", {
      conversationId: input.conversation.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      reply: ESCALATION_FALLBACK_LINE,
      escalate: true,
      optedOut: false,
      declined: false,
      captured: {},
    };
  }
}

/**
 * Execute one tool call and return the JSON output fed back to the model. Mutates
 * `result` for escalate/opt-out flags and merges captured keys. Capture validation
 * + persistence mirror the voice path (validateCapturedValues → captured_data +
 * leads upsert). Unknown tools return an error object rather than throwing.
 */
async function executeToolCall(
  name: string,
  rawArgs: string,
  input: {
    conversation: TextConversationRow;
    lead: LeadRecord | null;
    leadFields: LeadFieldRow[];
  },
  result: SmsTurnResult
): Promise<Record<string, unknown>> {
  if (name === "escalate_to_human") {
    result.escalate = true;
    return { ok: true };
  }
  if (name === "mark_opted_out") {
    result.optedOut = true;
    return { ok: true };
  }
  if (name === "mark_not_interested") {
    result.declined = true;
    return { ok: true };
  }
  if (name === "capture_lead_info") {
    const args = safeParseArgs(rawArgs);
    const { valid, invalid } = validateCapturedValues(input.leadFields, args);
    const savedKeys = Object.keys(valid);

    if (savedKeys.length > 0) {
      result.captured = { ...result.captured, ...valid };
      await mergeConversationCapturedData(input.conversation.id, valid);

      const { updates, hasLeadColumns } = buildLeadColumnUpdates(valid);
      if (hasLeadColumns) {
        await upsertLead({
          phone_number: input.conversation.phone_number,
          ...updates,
          status: "quoted",
          last_contacted_at: new Date().toISOString(),
        });
      }
    }

    if (Object.keys(invalid).length > 0) {
      return { status: "rejected", invalid, saved: savedKeys };
    }
    return { ok: true };
  }
  return { error: `unknown tool: ${name}` };
}

/** Parse a tool-call arguments string; returns {} on empty/invalid JSON. */
function safeParseArgs(raw: string): Record<string, unknown> {
  if (!raw || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
