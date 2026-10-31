# Draft review note for PR 16966 (parked ownership wait)

Status: **draft, not posted**. For a later contribution to the PR after internal review and owner approval.

---

Thank you, Moody Salem, for this change. Parking a wake that is blocked only by the outgoing run's
execution ownership as `deferred_issue_execution`, instead of storing it as a terminal `skipped` receipt,
fixes the handoff lease race at its cause. We tested it on a recent `master` and want to share what we
found.

## What we tested

We ported the PR head (`3803bcb898`) onto `master` at `f5e5b05a33` and ran nine outcome cases against the
PR's own entry points (executor cleanup and the shared delivery-work worker). Each case seeds an issue whose
previous run was cancelled by the handoff while its environment lease is still active, sends the new
participant's wake, and checks how many runs the new participant gets.

| Case | Expectation | Result |
|---|---|---|
| P1 plain reassignment handoff | one run after the lease is released | pass |
| S1 review stage, state still on that stage | exactly one run | pass |
| S2 issue already moved to another stage | no run | pass |
| S3 lease still held | no run yet, then exactly one after release | pass |
| R1 return leg after `changes_requested` (`wakeRole: executor`) | one run for the return assignee | pass |
| R2 admission fails once, a later pass delivers | exactly one run | pass |
| R3 lease released while the agent is suppressed | one run after the suppression ends | pass |
| L1 cleanup hook missed, worker pass after 30 minutes | one run | pass |
| L2 cleanup hook missed, worker pass after 24 hours | one run | pass |

All nine pass. The PR's own `heartbeat-execution-ownership-wait.test.ts` (25 tests) also passes on the
port, apart from the timing issue described below. We found no regressions in the 17 existing test files
that cover `execution_owner_active` or `execution_reconciliation_required` (same results as `master`,
test for test).

## Two conflicts resolved by hand on master

These resolutions are ours, not the PR's. Please check that they match your intent.

1. **Execution-wait actor check in `server/src/services/heartbeat/queue.ts`.** On the PR head, the
   non-ownership branch of the `deferred_issue_execution` lookup compares `requestedByActorType` with the
   wake's actor only for a failed-run task retry (`durableRequest?.failedRunRetry && opts.taskRetryRequestId`)
   and otherwise with `"user"`. `master` has since dropped that task-retry special case and uses the wake's
   actor for any durable request (`durableRequest ? opts.requestedByActorType ?? "" : "user"`). We kept the
   PR's `ownershipWaitResume` branch unchanged and used master's rule for the other branch.
2. **`deferBlockedExecution` blocker type.** `master` narrowed the parameter to
   `Pick<…, "recoveryActionId" | "cause" | "nextAction">`. The PR reads `executionBlocker.runId` to record
   which run holds ownership. We widened the type with an optional `runId`
   (`& Partial<Pick<…, "runId">>`), so existing callers compile unchanged and the ownership hold still
   records the run when the blocker provides it.

The rest of the port was mechanical (an additive entry in the delivery queue list and a duplicate import).

## Timing-sensitive test

"shared ownership-wait worker › observes nested admission only after outer settlement (rollback=false)"
failed intermittently in our runs: `settle()` waits up to 5 seconds for `idleWorkSnapshot().active` to
reach 0, and in a failing run the admitted successor run was still tracked as active when that wait ended
(`active === 1`). See the counts and the proposed adjustment in the accompanying report section
"Flaky test"; we did not change the test.

<!-- FLAKY-DETAIL -->
