import { resolveEffectiveConfig } from "../config";
import { logger } from "../logger";
import { BOT_ID, loadRemoteConfig } from "../db/remoteConfig";
import { roleAllows } from "../roles";
import { getOpenAI } from "../ai/openaiClient";
import {
  countMessagesSince,
  getActiveTextStages,
  getLastSuggestionAt,
  getMessagesForConversations,
  getRecentConversations,
  insertScriptSuggestion,
  type ActiveStageRow,
  type AnalysisMessageRow,
  type NewScriptSuggestion,
  type RecentConversationRow,
  type SuggestionEvidence,
  type SuggestionFlow,
  type SuggestionType,
} from "./suggestionQueries";

/**
 * Script-suggestion learning loop.
 *
 * A daily (24h) never-throw poller — same style as the campaign workers — that, for
 * THIS tenant when it's a texting bot, reads the last 7 days of text conversations
 * and the active text_stages, then makes ONE OpenAI structured-output call asking for
 * up to 5 concrete script-improvement suggestions (drop-off points, uncovered
 * questions, confusing wording), each citing evidence from real conversations. Each
 * suggestion is inserted as a PENDING script_suggestions row; an operator approves or
 * rejects it in the dashboard. The analyzer NEVER edits text_stages/script_stages and
 * never suggests against a stage that isn't currently active.
 *
 * runAnalysisOnce() is exported for tests/manual runs. Nothing here ever throws to the
 * interval: config load, the OpenAI call, malformed model output, and DB writes are
 * all guarded so one bad tick can't kill the process.
 */

/** Default tick period (24h); overridable for tests via startAnalyzerWorker(intervalMs). */
export const ANALYZER_TICK_MS = 24 * 60 * 60 * 1000;

/** Only the text flow is analyzed today; the table + code stay flow-agnostic. */
const FLOW: SuggestionFlow = "text";

/** How far back to pull conversations. */
const LOOKBACK_DAYS = 7;

/** Cap on conversations analyzed per tick (most recent first) to bound the prompt. */
const CONVERSATION_CAP = 50;

/** Overall cap on messages pulled per tick, so a huge backlog can't blow context. */
const MESSAGE_CAP = 600;

/** Max suggestions accepted from the model per tick. */
const MAX_SUGGESTIONS = 5;

/**
 * Skip the tick entirely when fewer than this many messages have arrived since the
 * last suggestion — there's nothing new to learn, so don't burn an OpenAI call.
 */
const MIN_NEW_MESSAGES = 5;

const VALID_SUGGESTION_TYPES: ReadonlySet<string> = new Set<SuggestionType>([
  "reword",
  "new_stage",
  "new_faq",
]);

/** One suggestion as returned by the model (before we validate/map it). */
interface RawSuggestion {
  stage_key: string | null;
  suggestion_type: string;
  current_text: string | null;
  suggested_text: string;
  rationale: string;
  evidence: SuggestionEvidence[];
}

const ANALYSIS_SYSTEM = `You improve the SMS sales script of an AI texting agent by studying REAL conversations.
Find up to 5 concrete, high-value improvements. Focus on:
- where customers drop off or go quiet,
- questions the current script does not answer,
- wording that is confusing, pushy, or off-putting.
Rules:
- Every suggestion MUST cite evidence: real conversation ids from the data plus a short verbatim snippet.
- For a "reword", set stage_key to the EXACT stage_key of an existing stage shown below; suggested_text is the improved line.
- For a brand-new stage use "new_stage"; for an FAQ/answer the script lacks use "new_faq"; leave stage_key null for those.
- Keep suggested_text short and send-ready (one SMS-sized message). Do not invent conversation ids.
- If there is nothing worth changing, return an empty list.
Respond ONLY with a single JSON object shaped exactly:
{
  "suggestions": [
    {
      "stage_key": "existing stage_key or null",
      "suggestion_type": "reword | new_stage | new_faq",
      "current_text": "the current line you'd replace, or null",
      "suggested_text": "the improved / new line",
      "rationale": "why this helps, grounded in the evidence",
      "evidence": [ { "conversation_id": "uuid from the data", "snippet": "short verbatim quote" } ]
    }
  ]
}
No prose outside the JSON.`;

/** Render the active stages into a compact block for the prompt. */
function stagesToText(stages: ActiveStageRow[]): string {
  if (stages.length === 0) return "(no active stages)";
  return stages
    .map(
      (s) =>
        `- stage_key="${s.stage_key}" type=${s.stage_type}${
          s.title ? ` title="${s.title}"` : ""
        }\n  text: ${s.script_text ?? "(empty)"}`
    )
    .join("\n");
}

/**
 * Render conversations + their messages into a compact transcript block, grouping
 * messages under their conversation id so the model can cite that id as evidence.
 */
function conversationsToText(
  conversations: RecentConversationRow[],
  messages: AnalysisMessageRow[]
): string {
  const byConvo = new Map<string, AnalysisMessageRow[]>();
  for (const m of messages) {
    const list = byConvo.get(m.conversation_id) ?? [];
    list.push(m);
    byConvo.set(m.conversation_id, list);
  }
  const blocks: string[] = [];
  for (const c of conversations) {
    const msgs = byConvo.get(c.id) ?? [];
    if (msgs.length === 0) continue;
    const lines = msgs
      .map((m) => `${m.direction === "inbound" ? "Customer" : "Bot"}: ${m.body}`)
      .join("\n");
    blocks.push(
      `conversation_id: ${c.id} (status=${c.status}, trigger=${c.trigger})\n${lines}`
    );
  }
  return blocks.length > 0 ? blocks.join("\n\n---\n\n") : "(no messages)";
}

/**
 * Parse + shallow-validate the model's JSON into a list of raw suggestions. Throws on
 * fully-malformed output (no JSON object / no suggestions array) so the caller can log
 * + skip. Individual malformed items are NOT thrown on here — they're dropped later in
 * toValidSuggestion so one bad item can't discard the whole batch.
 */
export function parseSuggestions(raw: string): RawSuggestion[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("no JSON object in analyzer output");
  }
  const parsed = JSON.parse(raw.slice(start, end + 1)) as {
    suggestions?: unknown;
  };
  if (!Array.isArray(parsed.suggestions)) {
    throw new Error("analyzer output missing suggestions array");
  }
  return parsed.suggestions as RawSuggestion[];
}

/**
 * Validate + map ONE raw suggestion into an insertable row, or null when it should be
 * dropped. Enforces the core learning-loop invariants:
 *   - suggestion_type must be known,
 *   - suggested_text + rationale must be non-empty,
 *   - evidence must reference conversations we actually loaded (no invented ids) and
 *     have at least one usable snippet,
 *   - a "reword" must target a still-ACTIVE stage (by stage_key) — otherwise dropped,
 *     so we never suggest against an inactive/removed stage. current_text is taken
 *     from the live stage, not the model.
 */
export function toValidSuggestion(
  raw: RawSuggestion,
  stagesByKey: Map<string, ActiveStageRow>,
  knownConversationIds: ReadonlySet<string>
): NewScriptSuggestion | null {
  if (!raw || typeof raw !== "object") return null;

  const type = String(raw.suggestion_type ?? "").trim();
  if (!VALID_SUGGESTION_TYPES.has(type)) return null;
  const suggestionType = type as SuggestionType;

  const suggestedText =
    typeof raw.suggested_text === "string" ? raw.suggested_text.trim() : "";
  const rationale = typeof raw.rationale === "string" ? raw.rationale.trim() : "";
  if (suggestedText === "" || rationale === "") return null;

  // Evidence: keep only items citing a conversation we actually analyzed, with a
  // non-empty snippet. Drop the suggestion when nothing survives.
  const evidence: SuggestionEvidence[] = Array.isArray(raw.evidence)
    ? raw.evidence
        .filter(
          (e): e is SuggestionEvidence =>
            !!e &&
            typeof e.conversation_id === "string" &&
            knownConversationIds.has(e.conversation_id) &&
            typeof e.snippet === "string" &&
            e.snippet.trim() !== ""
        )
        .map((e) => ({ conversation_id: e.conversation_id, snippet: e.snippet.trim() }))
    : [];
  if (evidence.length === 0) return null;

  let stageId: number | null = null;
  let currentText: string | null = null;
  if (suggestionType === "reword") {
    const key = typeof raw.stage_key === "string" ? raw.stage_key.trim() : "";
    const stage = key ? stagesByKey.get(key) : undefined;
    // A reword must target a real, still-active stage — else drop it entirely.
    if (!stage) return null;
    stageId = stage.id;
    currentText = stage.script_text;
  }

  return {
    flow: FLOW,
    stageId,
    suggestionType,
    currentText,
    suggestedText,
    rationale,
    evidence,
  };
}

/**
 * One analysis tick: gate on role + "nothing new", load recent conversations and the
 * active stages, make one OpenAI call, and insert the resulting pending suggestions.
 * Exported for unit tests / manual runs. Never throws.
 */
export async function runAnalysisOnce(now: Date = new Date()): Promise<void> {
  try {
    await loadRemoteConfig();
    const cfg = await resolveEffectiveConfig();

    // Role gate (fresh per tick): only texting bots get analyzed.
    if (!roleAllows(cfg.botRole, "sms")) return;

    // "Nothing new" skip: if too few messages arrived since the last suggestion,
    // there's nothing to learn — don't spend an OpenAI call.
    const lastAt = await getLastSuggestionAt(FLOW);
    const newCount = await countMessagesSince(lastAt);
    if (newCount < MIN_NEW_MESSAGES) {
      logger.info("Analyzer tick skipped: not enough new messages since last run", {
        botId: BOT_ID,
        newCount,
        minRequired: MIN_NEW_MESSAGES,
      });
      return;
    }

    const conversations = await getRecentConversations({
      sinceDays: LOOKBACK_DAYS,
      limit: CONVERSATION_CAP,
      now,
    });
    if (conversations.length === 0) {
      logger.info("Analyzer tick skipped: no recent conversations", { botId: BOT_ID });
      return;
    }

    const [stages, messages] = await Promise.all([
      getActiveTextStages(),
      getMessagesForConversations(
        conversations.map((c) => c.id),
        MESSAGE_CAP
      ),
    ]);
    if (messages.length === 0) {
      logger.info("Analyzer tick skipped: recent conversations have no messages", {
        botId: BOT_ID,
      });
      return;
    }

    const userPrompt = `Current ACTIVE script stages:\n${stagesToText(
      stages
    )}\n\nReal conversations from the last ${LOOKBACK_DAYS} days:\n${conversationsToText(
      conversations,
      messages
    )}\n\nSuggest up to ${MAX_SUGGESTIONS} improvements as specified.`;

    let raws: RawSuggestion[];
    try {
      const openai = await getOpenAI();
      const response = await openai.chat.completions.create({
        model: cfg.text.model,
        max_tokens: 1200,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: ANALYSIS_SYSTEM },
          { role: "user", content: userPrompt },
        ],
      });
      raws = parseSuggestions(response.choices[0]?.message?.content ?? "");
    } catch (err) {
      // Malformed model output / API failure → log + skip. Never throw to the tick.
      logger.error("Analyzer OpenAI call or parse failed; skipping tick", {
        botId: BOT_ID,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const stagesByKey = new Map(stages.map((s) => [s.stage_key, s]));
    const knownIds = new Set(conversations.map((c) => c.id));

    let inserted = 0;
    for (const raw of raws.slice(0, MAX_SUGGESTIONS)) {
      const suggestion = toValidSuggestion(raw, stagesByKey, knownIds);
      if (!suggestion) continue;
      if (await insertScriptSuggestion(suggestion)) inserted++;
    }

    logger.info("Analyzer tick complete", {
      botId: BOT_ID,
      candidates: raws.length,
      inserted,
    });
  } catch (err) {
    logger.error("Analyzer tick failed unexpectedly", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Start the daily analyzer poller. Non-fatal by contract (runAnalysisOnce swallows its
 * own errors) and self-guarded against overlapping runs if a tick outlasts the
 * interval. Returns the timer handle; unref'd so it never keeps the process alive.
 */
export function startAnalyzerWorker(
  intervalMs: number = ANALYZER_TICK_MS
): ReturnType<typeof setInterval> {
  timer = setInterval(async () => {
    if (running) return; // previous tick still in flight; skip this beat
    running = true;
    try {
      await runAnalysisOnce();
    } finally {
      running = false;
    }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  logger.info("Script-suggestion analyzer worker started", { intervalMs });
  return timer;
}

/** Stop the poller (used in tests / graceful shutdown). */
export function stopAnalyzerWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
