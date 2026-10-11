import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { QUEUED_RUN_STALENESS_ERROR_CODES } from "../modules/run-dispatch/index.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";

type Run = typeof heartbeatRuns.$inferSelect;
type DispatchFields = "startedAt" | "runtimeModeResolvedAt" | "processPid" | "processGroupId" |
  "processStartedAt" | "nativeIssueId" | "nativeSessionId" | "sessionIdAfter" |
  "controllerBootId" | "controllerLeaseExpiresAt" | "executionStage";

/** Every queued-run staleness code is a pre-dispatch cancel except
 * `execution_reconciliation_required`, which reports an existing hold rather
 * than a run that merely lost its target. Derived so a new code is a decision.
 * Read at call time: the run-dispatch index can be mid-evaluation when this
 * module loads through an import cycle. */
function isPreDispatchCancelCode(code: string): boolean {
  return code !== "execution_reconciliation_required" &&
    (QUEUED_RUN_STALENESS_ERROR_CODES as readonly string[]).includes(code);
}

/** The dispatcher gate and the claim-time dependency gate both cancel a queued
 * run before any execution authority is claimed; each stamps its own source. */
function hasPreDispatchCancelSource(run: Pick<Run, "errorCode" | "resultJson">): boolean {
  const source = run.resultJson?.timeoutSource;
  return source === "stale_queued_run_gate" ||
    (source === "dependency_gate" && run.errorCode === "issue_dependencies_blocked");
}

/** True only when the run row carries no evidence that execution authority
 * was ever claimed: a legacy run with every dispatch field still empty and no
 * unsafe workspace archive. Any missing or conflicting field fails closed. */
export function hasNoDispatchEvidenceOnRow(
  run: Pick<Run, "runtimeMode" | "resultJson"> & Partial<Pick<Run, DispatchFields>>,
): boolean {
  return run.runtimeMode === "legacy" &&
    run.resultJson?.workspaceRestoreFailure !== "restore_unsafe_archive" &&
    run.startedAt === null && run.runtimeModeResolvedAt === null &&
    run.processPid === null && run.processGroupId === null && run.processStartedAt === null &&
    run.nativeIssueId === null && run.nativeSessionId === null && run.sessionIdAfter === null &&
    run.controllerBootId === null && run.controllerLeaseExpiresAt === null && run.executionStage === null;
}

/** The row check is a candidate, not permission to discard conflicting
 * retained execution or cleanup evidence: a finalization coordinator, an
 * unreleased or unterminated environment lease, or a recorded execution event
 * each mean the run may have reached its provider. */
export async function hasVerifiedNoDispatchEvidence(db: Db, run: Run): Promise<boolean> {
  if (!hasNoDispatchEvidenceOnRow(run)) return false;
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

/** The queued-run gate owns this receipt before execution authority is claimed.
 * A run it cancelled has no provider actions to reconcile. The error code alone
 * is not proof; missing or conflicting dispatch evidence retains the hold. */
export function isPreDispatchCancel(
  run: Pick<Run, "runtimeMode" | "status" | "errorCode" | "resultJson"> & Partial<Pick<Run, DispatchFields>>,
): boolean {
  return run.status === "cancelled" &&
    run.errorCode != null && isPreDispatchCancelCode(run.errorCode) &&
    run.resultJson?.stopReason === run.errorCode &&
    hasPreDispatchCancelSource(run) &&
    hasNoDispatchEvidenceOnRow(run);
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
  return isPreDispatchCancel(run) && await hasVerifiedNoDispatchEvidence(db, run);
}
