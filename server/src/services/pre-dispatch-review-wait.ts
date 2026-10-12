import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { QUEUED_RUN_STALENESS_ERROR_CODES } from "../modules/run-dispatch/index.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";

type Run = typeof heartbeatRuns.$inferSelect;
type DispatchFields = "startedAt" | "runtimeModeResolvedAt" | "processPid" | "processGroupId" |
  "processStartedAt" | "nativeIssueId" | "nativeSessionId" | "sessionIdAfter" |
  "controllerBootId" | "controllerLeaseExpiresAt" | "executionStage" | "contextSnapshot";

/** Every queued-run staleness code is a pre-dispatch cancel except
 * `execution_reconciliation_required`, which reports an existing hold rather
 * than a run that merely lost its target, and `issue_waiting_for_response`,
 * which also needs its connection-intent snapshot (see below). Derived from
 * the staleness code list, so a new code is accepted unless it is excluded
 * here. Read at call time: the run-dispatch index can be mid-evaluation when
 * this module loads through an import cycle. */
function isPreDispatchCancelCode(code: string): boolean {
  return code !== "execution_reconciliation_required" && code !== "issue_waiting_for_response" &&
    (QUEUED_RUN_STALENESS_ERROR_CODES as readonly string[]).includes(code);
}

/** A connection response wait is a pre-dispatch cancel only with the resolved
 * connection-intent snapshot; the error code alone does not qualify. */
function isConnectionResponseWait(run: Partial<Pick<Run, "errorCode" | "contextSnapshot">>): boolean {
  return run.errorCode === "issue_waiting_for_response" &&
    run.contextSnapshot?.connectionIntentResolution === "existing_connection" &&
    run.contextSnapshot?.source === "connection_intent.resolved" &&
    run.contextSnapshot?.interactionKind === "connection_intent" &&
    run.contextSnapshot?.interactionStatus === "expired" &&
    run.contextSnapshot?.mutation === "interaction" &&
    typeof run.contextSnapshot?.interactionId === "string";
}

/** A final response wait records that no provider work started, which also
 * covers dispatch fields the response gate fills before it cancels. */
function isFinalResponseWait(run: Pick<Run, "resultJson"> & Partial<Pick<Run, "errorCode">>): boolean {
  const receipt = run.resultJson?.preDispatchResponseWait as { version?: number; providerWorkStarted?: boolean } | undefined;
  return run.errorCode === "issue_waiting_for_response" && receipt?.version === 1 && receipt.providerWorkStarted === false;
}

/** Stamped by the issue route when a reassignment cancels the previous
 * assignee's queued runs in the same transaction as the new assignee. */
export const REASSIGNMENT_QUEUE_CANCEL_SOURCE = "reassignment_queue_cancel";

/** The dispatcher gate, the claim-time dependency gate and the reassignment
 * cancel each stop a queued run before any execution authority is claimed;
 * each stamps its own source, valid only with its own codes. */
function hasPreDispatchCancelSource(run: Pick<Run, "errorCode" | "resultJson"> & Partial<Pick<Run, "contextSnapshot">>): boolean {
  const source = run.resultJson?.timeoutSource;
  if (source === "stale_queued_run_gate") {
    return isConnectionResponseWait(run) || (run.errorCode != null && isPreDispatchCancelCode(run.errorCode));
  }
  if (source === "dependency_gate") return run.errorCode === "issue_dependencies_blocked";
  if (source === REASSIGNMENT_QUEUE_CANCEL_SOURCE) return run.errorCode === "issue_reassigned";
  return false;
}

/** True only when the run row carries no evidence that execution authority
 * was ever claimed: a legacy run with every dispatch field still empty and no
 * unsafe workspace archive. Any missing or conflicting field fails closed. */
function hasNoDispatchEvidenceOnRow(
  run: Pick<Run, "runtimeMode" | "resultJson"> & Partial<Pick<Run, DispatchFields | "errorCode">>,
): boolean {
  const finalResponseWait = isFinalResponseWait(run);
  return run.runtimeMode === "legacy" &&
    run.resultJson?.workspaceRestoreFailure !== "restore_unsafe_archive" &&
    (finalResponseWait || (run.startedAt === null && run.runtimeModeResolvedAt === null)) &&
    run.processPid === null && run.processGroupId === null && run.processStartedAt === null &&
    run.nativeIssueId === null && run.nativeSessionId === null && run.sessionIdAfter === null &&
    (finalResponseWait || (run.controllerBootId === null && run.controllerLeaseExpiresAt === null && run.executionStage === null));
}

/** The row check is a candidate, not permission to discard conflicting
 * retained execution or cleanup evidence: a finalization coordinator, an
 * unreleased or unterminated environment lease, or a recorded execution event
 * each mean the run may have reached its provider. */
async function hasVerifiedNoDispatchEvidence(db: Db, run: Run): Promise<boolean> {
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

/** A pre-dispatch cancel receipt: a run stopped before execution authority
 * was claimed has no provider actions to reconcile. The error code alone
 * is not proof; missing or conflicting dispatch evidence retains the hold. */
export function isPreDispatchCancel(
  run: Pick<Run, "runtimeMode" | "status" | "errorCode" | "resultJson"> & Partial<Pick<Run, DispatchFields>>,
): boolean {
  return run.status === "cancelled" &&
    run.errorCode != null &&
    run.resultJson?.stopReason === run.errorCode &&
    hasPreDispatchCancelSource(run) &&
    hasNoDispatchEvidenceOnRow(run);
}

/** A deliberate review or connection response wait is the pre-dispatch cancel
 * that also changes operator-facing copy and native startup admission. */
export function isPreDispatchReviewWait(
  run: Pick<Run, "runtimeMode" | "status" | "errorCode" | "resultJson"> & Partial<Pick<Run, DispatchFields>>,
): boolean {
  return (run.errorCode === "issue_continuation_waiting_on_review" || run.errorCode === "issue_waiting_for_response") &&
    isPreDispatchCancel(run);
}

/** The row receipt is a candidate, not permission to discard conflicting
 * retained execution or cleanup evidence. Historical false holds must be
 * checked against the same evidence that gates explicit user admission. */
export async function isPreDispatchCancelVerified(db: Db, run: Run): Promise<boolean> {
  return isPreDispatchCancel(run) && await hasVerifiedNoDispatchEvidence(db, run);
}
