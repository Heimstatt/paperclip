/**
 * Decides which queued runs of a previous assignee a reassignment cancels.
 *
 * A run is cancelled only when its wake reason is known to come from a
 * producer that chose the agent because it owned the issue: it was the
 * assignee, or it was continuing, retrying or recovering its own execution.
 * Every other reason, including unknown and caller-supplied ones, is left
 * alone. The classification of each reason is derived from its producers and
 * recorded in doc/plans/2026-10-11-reassign-queued-run.md.
 */

/** Reasons whose producers all target the issue's owner. */
export const OWNERSHIP_WAKE_REASONS: ReadonlySet<string> = new Set([
  // Wakes sent to the assignee of the issue in the run context.
  "issue_assigned",
  "issue_checked_out",
  "issue_status_changed",
  "issue_commented",
  "issue_reopened_via_comment",
  "issue_children_completed",
  "issue_blockers_resolved",
  "execution_changes_requested",
  "issue_tree_restored",
  "issue_tree_resumed",
  "issue_recovery_action_restored",
  "issue_review_path_lost",
  "issue_monitor_due",
  "issue_monitor_recovery",
  "issue_monitor_recovery_issue",
  "status_card_update_assigned",
  "status_card_compile_assigned",
  "summary_slot_generation_requested",
  "secret_proposal_resolved",
  "email_received",
  "chat_task_completed",
  "skill_test_run_created",
  "goal_control",
  // The same agent continuing, retrying or recovering its own execution.
  "run_liveness_continuation",
  "finish_successful_run_handoff",
  "issue_continuation_needed",
  "issue_assignment_recovery",
  "issue_disposition_repair",
  "max_turns_continuation_retry",
  "interaction_continuation_infra_retry",
  "provider_quota_recovery",
  "native_safe_replacement",
]);

/**
 * Wait retries keep the source run's agent and record on the run whether that
 * agent was the assignee when the wait began.
 */
const ASSIGNEE_FLAG_BY_WAIT_RETRY_REASON: Readonly<Record<string, string>> = {
  workspace_busy_retry: "workspaceBusyDeferredWhileAssignee",
  ai_connection_busy_retry: "aiConnectionBusyDeferredWhileAssignee",
  ai_connection_pool_retry: "aiConnectionBusyDeferredWhileAssignee",
};

/**
 * Retries that keep the source run's agent but overwrite its wake reason, and
 * record no assignee flag. They own the issue exactly when their source did.
 */
const SOURCE_FOLLOWING_RETRY_REASONS: ReadonlySet<string> = new Set([
  "transient_failure_retry",
  "missing_issue_comment",
  "native_provider_overloaded",
]);

export type ReassignmentRunOwnership = "ownership" | "not_ownership" | "follow_source";

export function classifyRunForReassignment(
  contextSnapshot: Record<string, unknown> | null | undefined,
): ReassignmentRunOwnership {
  const wakeReason = contextSnapshot?.wakeReason;
  if (typeof wakeReason !== "string") return "not_ownership";
  if (OWNERSHIP_WAKE_REASONS.has(wakeReason)) return "ownership";
  const assigneeFlag = ASSIGNEE_FLAG_BY_WAIT_RETRY_REASON[wakeReason];
  if (assigneeFlag) return contextSnapshot?.[assigneeFlag] === true ? "ownership" : "not_ownership";
  if (SOURCE_FOLLOWING_RETRY_REASONS.has(wakeReason)) return "follow_source";
  return "not_ownership";
}
