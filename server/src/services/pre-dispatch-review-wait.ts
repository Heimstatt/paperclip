import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";

type Run = typeof heartbeatRuns.$inferSelect;
type DispatchFields = "startedAt" | "runtimeModeResolvedAt" | "processPid" | "processGroupId" |
  "processStartedAt" | "nativeIssueId" | "nativeSessionId" | "sessionIdAfter" |
  "controllerBootId" | "controllerLeaseExpiresAt" | "executionStage";

/** Queued-run staleness codes written by the dispatcher gate before a run is
 * claimed. `execution_reconciliation_required` is excluded: it reports an
 * existing hold rather than a run that merely lost its target. */
const PRE_DISPATCH_CANCEL_CODES: ReadonlySet<string> = new Set([
  "issue_dependencies_blocked", "issue_not_found", "issue_assignee_changed", "issue_terminal_status",
  "issue_not_in_progress", "issue_execution_lock_changed", "issue_blocked", "issue_review_participant_changed",
  "issue_continuation_waiting_on_review",
]);

/** The queued-run gate owns this receipt before execution authority is claimed.
 * A run it cancelled has no provider actions to reconcile. The error code alone
 * is not proof; missing or conflicting dispatch evidence retains the hold. */
export function isPreDispatchCancel(
  run: Pick<Run, "runtimeMode" | "status" | "errorCode" | "resultJson"> & Partial<Pick<Run, DispatchFields>>,
): boolean {
  return run.runtimeMode === "legacy" && run.status === "cancelled" &&
    run.errorCode != null && PRE_DISPATCH_CANCEL_CODES.has(run.errorCode) &&
    run.resultJson?.stopReason === run.errorCode &&
    run.resultJson?.timeoutSource === "stale_queued_run_gate" &&
    run.resultJson?.workspaceRestoreFailure !== "restore_unsafe_archive" &&
    run.startedAt === null && run.runtimeModeResolvedAt === null &&
    run.processPid === null && run.processGroupId === null && run.processStartedAt === null &&
    run.nativeIssueId === null && run.nativeSessionId === null && run.sessionIdAfter === null &&
    run.controllerBootId === null && run.controllerLeaseExpiresAt === null && run.executionStage === null;
}

/** A deliberate review wait is the one pre-dispatch cancel that also changes
 * operator-facing copy and native startup admission. */
export function isPreDispatchReviewWait(
  run: Pick<Run, "runtimeMode" | "status" | "errorCode" | "resultJson"> & Partial<Pick<Run, DispatchFields>>,
): boolean {
  return run.errorCode === "issue_continuation_waiting_on_review" && isPreDispatchCancel(run);
}

/** The row receipt is a candidate, not permission to discard conflicting
 * retained execution or cleanup evidence. Historical false holds must be
 * checked against the same evidence that gates explicit user admission. */
export async function isPreDispatchCancelVerified(db: Db, run: Run): Promise<boolean> {
  if (!isPreDispatchCancel(run)) return false;
  const [coordinator] = await db.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id),
  )).limit(1);
  if (coordinator) return false;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
  if (leases.some(lease => lease.provider === "local"
    ? !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed"
    : !hasRemoteTerminationReceipt(lease))) return false;
  const [execution] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    or(isNotNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, ["adapter.invoke", PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED,
        "harness.ready", "session.started", "session.resumed", "session.updated", "turn.started",
        "provider.event", "provider.rpc_result", "tool.execution.started"])),
  )).limit(1);
  return !execution;
}
