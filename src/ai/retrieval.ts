import { config } from "../config";
import { logger } from "../logger";
import { createEmbedding } from "../speech/openai";
import {
  getApprovedRulesByCategory,
  matchApprovedRules,
} from "../db/learningQueries";
import { LearnedRule } from "../db/types";

/**
 * Retrieval side of the learning system: at call time, fetch the most relevant
 * APPROVED lessons and format them for injection into the system prompt.
 *
 * SAFETY: every path here is wrapped so a retrieval failure NEVER disrupts a live
 * call — on any error we return no lessons and the bot runs the core script unchanged.
 *
 * Two retrieval strategies:
 *   1. pgvector similarity (LEARNING_USE_PGVECTOR=true): embed the caller's line and
 *      call the match_learned_rules RPC.
 *   2. category lookup (default): guess the situation category from keywords and pull
 *      approved rules for that category (or the most recent approved rules overall).
 */

/** Lightweight keyword → category heuristic. Returns null if nothing obvious matches. */
export function detectCategory(text: string): string | null {
  const t = text.toLowerCase();
  if (/\b(shop|shopping|compare|cheaper|better rate|other quote|competitor)\b/.test(t))
    return "objection_shopping";
  if (/\b(spouse|wife|husband|partner|talk to my)\b/.test(t)) return "objection_spouse";
  if (/\b(fund|funds|money|afford|can'?t pay|no money|broke|paycheck)\b/.test(t))
    return "objection_funds";
  if (/\b(at work|working|busy|can'?t talk|call.*later|driving)\b/.test(t))
    return "objection_at_work";
  if (/\b(price|cost|expensive|too much|discount)\b/.test(t)) return "closing";
  return null;
}

export async function retrieveRelevantLessons(callerText: string): Promise<LearnedRule[]> {
  const limit = config.learning.retrievalLimit;
  try {
    const category = detectCategory(callerText);

    if (config.learning.usePgvector && callerText.trim()) {
      const embedding = await createEmbedding(callerText);
      if (embedding) {
        const matches = await matchApprovedRules(embedding, limit, category);
        if (matches.length > 0) return matches;
        // No vector matches (or RPC missing) — fall through to category lookup.
      }
    }

    return await getApprovedRulesByCategory(category, limit);
  } catch (err) {
    // Never let retrieval break a call.
    logger.error("Lesson retrieval failed; continuing with core script only", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Format approved lessons as a system-prompt section. Returns "" when there are none,
 * so buildSystemPrompt can omit the section entirely.
 */
export function formatLessonsForPrompt(rules: LearnedRule[]): string {
  if (rules.length === 0) return "";
  const items = rules
    .map((r, i) => {
      const lines = [
        `${i + 1}. [${r.category}] When: ${r.situation_summary}`,
        `   Do: ${r.recommended_response}`,
      ];
      if (r.avoid_response) lines.push(`   Avoid: ${r.avoid_response}`);
      return lines.join("\n");
    })
    .join("\n");

  return `\n\n# LESSONS FROM PAST CALLS (supplementary guidance — DO NOT override the core script above)
These are human-approved tips distilled from real calls. Treat them as helpful nudges layered on top of the script and hard rules. If any lesson ever conflicts with the hard rules or the 5-close/escalation logic, the core script wins.
${items}`;
}
