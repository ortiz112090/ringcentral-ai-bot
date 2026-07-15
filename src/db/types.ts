/**
 * Shared DB / domain types. Mirrors the SQL schema in supabase/migrations.
 */

export type CallOutcome =
  | "closed_pif"
  | "closed_installment"
  | "escalated"
  | "no_answer"
  | "follow_up_needed"
  | "abandoned";

export type Carrier = "progressive" | "dairyland" | "other";

export type LeadStatus =
  | "new"
  | "contacted"
  | "quoted"
  | "closed"
  | "escalated"
  | "lost";

/** One turn in the conversation, stored as JSONB on calls.transcript. */
export interface TranscriptTurn {
  role: "caller" | "bot";
  text: string;
  timestamp: string; // ISO
}

export interface CallRecord {
  call_id: string;
  caller_number: string | null;
  started_at: string;
  ended_at?: string | null;
  outcome?: CallOutcome | null;
  script_stage_reached?: string | null;
  transcript?: TranscriptTurn[] | null;
}

export interface LeadRecord {
  phone_number: string;
  first_name?: string | null;
  zip_code?: string | null;
  date_of_birth?: string | null;
  // Sensitive: driver's license number. Stored for quoting only; never used to run an MVR.
  license_number?: string | null;
  quote_amount_pif?: number | null;
  quote_amount_monthly?: number | null;
  carrier?: Carrier | null;
  status?: LeadStatus | null;
  last_contacted_at?: string | null;
}

// ---------- Learning system (see supabase/migrations/0002_learning_system.sql) ----------

export type TrainingSource = "upload_audio" | "upload_transcript" | "live_call";
export type TagType = "good_example" | "bad_example";
export type RuleStatus = "pending_review" | "approved" | "rejected";

/**
 * One turn of a training-call transcript. Uses "agent" (not "bot") because these are
 * real human agent calls used as learning material; distinct from live TranscriptTurn.
 */
export interface TrainingTurn {
  role: "caller" | "agent";
  text: string;
  timestamp?: string | null;
}

export interface TrainingCall {
  id: number;
  source: TrainingSource;
  audio_url?: string | null;
  transcript: TrainingTurn[];
  related_call_id?: string | null;
  uploaded_at: string;
  notes?: string | null;
}

export interface CallTag {
  id: number;
  training_call_id: number;
  segment_start?: string | null;
  segment_end?: string | null;
  tag_type: TagType;
  category: string;
  caller_line?: string | null;
  agent_line?: string | null;
  tagged_by: string;
  created_at: string;
}

export interface LearnedRule {
  id: number;
  source_tag_id?: number | null;
  category: string;
  situation_summary: string;
  recommended_response: string;
  avoid_response?: string | null;
  status: RuleStatus;
  created_at: string;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
}
