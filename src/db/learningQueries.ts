import { supabase } from "./supabase";
import { logger } from "../logger";
import {
  CallTag,
  LearnedRule,
  RuleStatus,
  TagType,
  TrainingCall,
  TrainingSource,
  TrainingTurn,
} from "./types";

/**
 * Failure-tolerant DB access for the learning-system tables, mirroring the pattern in
 * db/queries.ts: log and continue, never throw into the CLI/call path. Reads return
 * null/[] on failure; writes return the created row id (or null).
 */

// ---------- training_calls ----------

export async function insertTrainingCall(input: {
  source: TrainingSource;
  transcript: TrainingTurn[];
  audioUrl?: string | null;
  relatedCallId?: string | null;
  notes?: string | null;
}): Promise<number | null> {
  const { data, error } = await supabase
    .from("training_calls")
    .insert({
      source: input.source,
      transcript: input.transcript,
      audio_url: input.audioUrl ?? null,
      related_call_id: input.relatedCallId ?? null,
      notes: input.notes ?? null,
    })
    .select("id")
    .single();
  if (error) {
    logger.error("Failed to insert training call", { error: error.message });
    return null;
  }
  return data.id as number;
}

export async function getTrainingCall(id: number): Promise<TrainingCall | null> {
  const { data, error } = await supabase
    .from("training_calls")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    logger.error("Failed to fetch training call", { id, error: error.message });
    return null;
  }
  return (data as TrainingCall) ?? null;
}

// ---------- call_tags ----------

export async function insertCallTag(input: {
  trainingCallId: number;
  tagType: TagType;
  category: string;
  segmentStart?: string | null;
  segmentEnd?: string | null;
  callerLine?: string | null;
  agentLine?: string | null;
  taggedBy?: string;
}): Promise<number | null> {
  const { data, error } = await supabase
    .from("call_tags")
    .insert({
      training_call_id: input.trainingCallId,
      tag_type: input.tagType,
      category: input.category,
      segment_start: input.segmentStart ?? null,
      segment_end: input.segmentEnd ?? null,
      caller_line: input.callerLine ?? null,
      agent_line: input.agentLine ?? null,
      tagged_by: input.taggedBy ?? "user",
    })
    .select("id")
    .single();
  if (error) {
    logger.error("Failed to insert call tag", { error: error.message });
    return null;
  }
  return data.id as number;
}

export async function getCallTag(id: number): Promise<CallTag | null> {
  const { data, error } = await supabase
    .from("call_tags")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    logger.error("Failed to fetch call tag", { id, error: error.message });
    return null;
  }
  return (data as CallTag) ?? null;
}

// ---------- learned_rules ----------

export async function insertLearnedRule(input: {
  sourceTagId?: number | null;
  category: string;
  situationSummary: string;
  recommendedResponse: string;
  avoidResponse?: string | null;
  embedding?: number[] | null;
}): Promise<number | null> {
  const payload: Record<string, unknown> = {
    source_tag_id: input.sourceTagId ?? null,
    category: input.category,
    situation_summary: input.situationSummary,
    recommended_response: input.recommendedResponse,
    avoid_response: input.avoidResponse ?? null,
    status: "pending_review",
  };
  // Only send the embedding when we actually have one (pgvector path).
  if (input.embedding && input.embedding.length > 0) {
    payload.embedding = input.embedding;
  }

  const { data, error } = await supabase
    .from("learned_rules")
    .insert(payload)
    .select("id")
    .single();
  if (error) {
    logger.error("Failed to insert learned rule", { error: error.message });
    return null;
  }
  return data.id as number;
}

export async function listLearnedRulesByStatus(
  status: RuleStatus
): Promise<LearnedRule[]> {
  const { data, error } = await supabase
    .from("learned_rules")
    .select("*")
    .eq("status", status)
    .order("created_at", { ascending: true });
  if (error) {
    logger.error("Failed to list learned rules", { status, error: error.message });
    return [];
  }
  return (data as LearnedRule[]) ?? [];
}

export async function setLearnedRuleStatus(
  id: number,
  status: RuleStatus,
  reviewedBy = "user"
): Promise<void> {
  const { error } = await supabase
    .from("learned_rules")
    .update({
      status,
      reviewed_at: new Date().toISOString(),
      reviewed_by: reviewedBy,
    })
    .eq("id", id);
  if (error) {
    logger.error("Failed to update learned rule status", { id, status, error: error.message });
  }
}

/**
 * Fetch approved rules by category (fallback retrieval when pgvector is off, or when
 * an embedding could not be produced). If category is null, returns the most recent
 * approved rules across all categories.
 */
export async function getApprovedRulesByCategory(
  category: string | null,
  limit: number
): Promise<LearnedRule[]> {
  let query = supabase
    .from("learned_rules")
    .select("*")
    .eq("status", "approved")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (category) {
    query = query.eq("category", category);
  }
  const { data, error } = await query;
  if (error) {
    logger.error("Failed to fetch approved rules", { category, error: error.message });
    return [];
  }
  return (data as LearnedRule[]) ?? [];
}

/**
 * pgvector similarity search via the match_learned_rules RPC (see migration 0002).
 * Returns approved rules ranked by embedding similarity. Returns [] on any failure so
 * the caller can fall back to category lookup.
 */
export async function matchApprovedRules(
  embedding: number[],
  limit: number,
  category: string | null
): Promise<LearnedRule[]> {
  const { data, error } = await supabase.rpc("match_learned_rules", {
    query_embedding: embedding,
    match_count: limit,
    filter_category: category,
  });
  if (error) {
    logger.error("Vector rule match failed; caller should fall back", {
      error: error.message,
    });
    return [];
  }
  return (data as LearnedRule[]) ?? [];
}
