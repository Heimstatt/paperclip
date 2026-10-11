import { describe, expect, it } from "vitest";
import { classifyRunForReassignment } from "./reassignment-ownership.js";

describe("classifyRunForReassignment", () => {
  it("treats owner wakes, including status changes sent to the assignee, as ownership", () => {
    expect(classifyRunForReassignment({ wakeReason: "issue_assigned" })).toBe("ownership");
    expect(classifyRunForReassignment({ wakeReason: "issue_status_changed" })).toBe("ownership");
    expect(classifyRunForReassignment({ wakeReason: "issue_commented" })).toBe("ownership");
    expect(classifyRunForReassignment({ wakeReason: "max_turns_continuation_retry" })).toBe("ownership");
  });

  it("leaves wakes addressed to an agent for another role alone", () => {
    for (const wakeReason of [
      "interaction_pending",
      "issue_unblock_requested",
      "execution_review_requested",
      "execution_approval_requested",
      "native_completion_review",
      "execution_review_participant_recovery",
      "decision_decided",
      "task_watchdog_stopped_subtree",
      "approval_approved",
      "retry_failed_run",
    ]) {
      expect(classifyRunForReassignment({ wakeReason })).toBe("not_ownership");
    }
  });

  it("uses the assignee flag recorded on wait retries", () => {
    expect(classifyRunForReassignment({
      wakeReason: "workspace_busy_retry",
      workspaceBusyDeferredWhileAssignee: true,
    })).toBe("ownership");
    expect(classifyRunForReassignment({
      wakeReason: "workspace_busy_retry",
      workspaceBusyDeferredWhileAssignee: false,
    })).toBe("not_ownership");
    expect(classifyRunForReassignment({
      wakeReason: "ai_connection_pool_retry",
      aiConnectionBusyDeferredWhileAssignee: true,
    })).toBe("ownership");
    expect(classifyRunForReassignment({ wakeReason: "ai_connection_busy_retry" })).toBe("not_ownership");
  });

  it("defers retries that overwrite the wake reason to their source run", () => {
    expect(classifyRunForReassignment({ wakeReason: "transient_failure_retry" })).toBe("follow_source");
    expect(classifyRunForReassignment({ wakeReason: "missing_issue_comment" })).toBe("follow_source");
    expect(classifyRunForReassignment({ wakeReason: "native_provider_overloaded" })).toBe("follow_source");
  });

  it("does not cancel runs with an unknown or missing wake reason", () => {
    expect(classifyRunForReassignment({ wakeReason: "plugin_supplied_reason" })).toBe("not_ownership");
    expect(classifyRunForReassignment({})).toBe("not_ownership");
    expect(classifyRunForReassignment(null)).toBe("not_ownership");
  });
});
