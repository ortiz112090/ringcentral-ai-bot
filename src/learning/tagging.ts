import { insertCallTag } from "../db/learningQueries";
import { TagType } from "../db/types";

/**
 * Tagging step: mark a segment of a training call as a good/bad example of handling a
 * given situation category. This is the "you mark this moment" action, exposed by the
 * tagging CLI. Returns the new tag id (or null on failure — errors are logged in the
 * DB layer).
 */

/** Suggested categories; free text is also allowed to keep tagging flexible. */
export const KNOWN_CATEGORIES = [
  "opener",
  "rapport",
  "quote_collection",
  "closing",
  "objection_shopping",
  "objection_spouse",
  "objection_funds",
  "objection_at_work",
  "other",
] as const;

export async function createTag(input: {
  trainingCallId: number;
  tagType: TagType;
  category: string;
  segmentStart?: string | null;
  segmentEnd?: string | null;
  callerLine?: string | null;
  agentLine?: string | null;
  taggedBy?: string;
}): Promise<number | null> {
  return insertCallTag(input);
}
