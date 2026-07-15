import {
  listLearnedRulesByStatus,
  setLearnedRuleStatus,
} from "../db/learningQueries";
import { LearnedRule } from "../db/types";

/**
 * Approval queue for learned rules. Written as plain reusable functions (no CLI/UI
 * coupling) so the review CLI today — and a future dashboard — can both call them.
 * Only 'approved' rules are ever retrieved into the live bot.
 */

export async function listPendingRules(): Promise<LearnedRule[]> {
  return listLearnedRulesByStatus("pending_review");
}

export async function approveRule(id: number, reviewedBy = "user"): Promise<void> {
  await setLearnedRuleStatus(id, "approved", reviewedBy);
}

export async function rejectRule(id: number, reviewedBy = "user"): Promise<void> {
  await setLearnedRuleStatus(id, "rejected", reviewedBy);
}
