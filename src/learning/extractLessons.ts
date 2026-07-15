import { config } from "../config";
import { logger } from "../logger";
import { anthropic, firstTextBlock } from "../ai/anthropicClient";
import { createEmbedding } from "../speech/openai";
import {
  getCallTag,
  getTrainingCall,
  insertLearnedRule,
} from "../db/learningQueries";
import { TrainingTurn } from "../db/types";

/**
 * Lesson extraction: given a tagged segment of a real call, ask Claude to distill a
 * general, reusable lesson (situation → recommended response, plus what to avoid for
 * bad examples), stripped of the specific caller's name/details. The result is stored
 * in `learned_rules` as 'pending_review' — never used live until a human approves it.
 */

interface ExtractedLesson {
  situation_summary: string;
  recommended_response: string;
  avoid_response: string | null;
}

/** Render a training transcript to a compact text block for the extraction prompt. */
function transcriptToText(turns: TrainingTurn[]): string {
  return turns
    .map((t) => `${t.role === "agent" ? "Agent" : "Caller"}: ${t.text}`)
    .join("\n");
}

const EXTRACTION_SYSTEM = `You analyze real insurance sales-call segments and distill GENERAL, REUSABLE coaching lessons for an AI phone agent.
Rules:
- Generalize. Never include the specific caller's name, phone, or one-off details.
- The lesson must apply to future calls in the same type of situation.
- Keep it concrete and short — this becomes few-shot guidance layered on top of a fixed script.
- Do NOT contradict these hard rules of the existing script: never run an MVR, keep replies short, escalate to a human when unsure or asked.
Respond ONLY with a single JSON object shaped exactly:
{
  "situation_summary": "when the caller says/does X (the trigger, generalized)",
  "recommended_response": "what the agent should say or do in that situation",
  "avoid_response": "for a BAD example: what to avoid saying/doing; otherwise null"
}
No prose outside the JSON.`;

/**
 * Extract a lesson from a tag and persist it as a pending learned rule.
 * Returns the new rule id, or null on any failure (all failures are logged).
 */
export async function extractLesson(tagId: number): Promise<number | null> {
  const tag = await getCallTag(tagId);
  if (!tag) {
    logger.warn("extractLesson: tag not found", { tagId });
    return null;
  }

  const training = await getTrainingCall(tag.training_call_id);
  const context = training ? transcriptToText(training.transcript) : "";

  const userPrompt = `This segment was marked as a ${tag.tag_type.toUpperCase()} example of handling category "${tag.category}".

Tagged caller line: ${tag.caller_line ?? "(not specified)"}
Tagged agent line: ${tag.agent_line ?? "(not specified)"}

Full call transcript for context:
${context || "(no surrounding transcript available)"}

Extract the generalized lesson as specified.`;

  let lesson: ExtractedLesson;
  try {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 500,
      system: EXTRACTION_SYSTEM,
      messages: [{ role: "user", content: userPrompt }],
    });
    lesson = parseLesson(firstTextBlock(response.content));
  } catch (err) {
    logger.error("Lesson extraction (Claude) failed", {
      tagId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Generate an embedding for semantic retrieval only when pgvector is enabled.
  let embedding: number[] | null = null;
  if (config.learning.usePgvector) {
    embedding = await createEmbedding(lesson.situation_summary);
  }

  const ruleId = await insertLearnedRule({
    sourceTagId: tag.id,
    category: tag.category,
    situationSummary: lesson.situation_summary,
    recommendedResponse: lesson.recommended_response,
    // Only keep an avoid_response for bad examples.
    avoidResponse: tag.tag_type === "bad_example" ? lesson.avoid_response : null,
    embedding,
  });

  logger.info("Extracted lesson into pending rule", { tagId, ruleId, category: tag.category });
  return ruleId;
}

/** Parse and validate Claude's JSON lesson output. Throws on malformed output. */
export function parseLesson(raw: string): ExtractedLesson {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("no JSON object in lesson output");
  }
  const parsed = JSON.parse(raw.slice(start, end + 1)) as Partial<ExtractedLesson>;
  if (
    typeof parsed.situation_summary !== "string" ||
    typeof parsed.recommended_response !== "string" ||
    parsed.situation_summary.trim() === "" ||
    parsed.recommended_response.trim() === ""
  ) {
    throw new Error("lesson missing required fields");
  }
  return {
    situation_summary: parsed.situation_summary,
    recommended_response: parsed.recommended_response,
    avoid_response:
      typeof parsed.avoid_response === "string" && parsed.avoid_response.trim() !== ""
        ? parsed.avoid_response
        : null,
  };
}
