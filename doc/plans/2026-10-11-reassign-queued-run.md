# Reassignment With a Queued Previous-Assignee Run

Notes for the fix to public issue paperclipai/paperclip#14879: "Reassigning an
issue does not cancel the previous assignee's queued run, so the new
assignee's wake stays deferred".

- Branch: `fix/14879-reassign-queued-run`
- Started from: `e733bddc45e00efb1819fffa8677f7b0d07802c5` (`master`)

## Root Cause

**Path (a): reassignment with a queued previous-assignee run.**
The issue route cancelled only the previous assignee's *running* run (errorCode
`issue_reassigned`). A run queued by an ordinary wake does not take
`issues.executionRunId`. When the new assignee's wake was enqueued, no lock
holder was set, so the legacy fallback in `enqueueWakeup`
(`server/src/services/heartbeat/queue.ts`) adopted the old queued run as the
holder. That fallback runs after the cross-agent reassignment guard, so the
guard never saw the run. The new wake was parked as `deferred_issue_execution`.

**Path (b): the stale queued-run gate cancels the holder later.**
`cancelStaleRunInTx` (`server/src/modules/run-dispatch/adapters/postgres.ts`)
clears the issue lock inside its transaction but does not drain the wakes
parked behind it. `claimQueuedRun` returned on `cancelled` without a release.
Calling the normal release afterwards was not enough on its own either. The
wake-queue pre-drain (`decidePreDrain` together with
`legacyExecutionNeedsReconciliationWithEvidence`) treats a cancelled legacy run
with no execution evidence as possibly having done provider work. So it skipped
promotion and held the deferred wake for reconciliation.

## Changes

- `server/src/routes/issues.ts`: on reassignment, look up the previous
  assignee's queued runs for the issue. This happens before the running run is
  stopped, because that stop frees a slot that could start one of them. Each
  run is cancelled through the same `heartbeat.cancelRun` path used for started
  runs (errorCode `issue_reassigned`).
  - `issue_comment_mentioned` and `interaction_pending` wakes are skipped.
  - Immediate recovery is suppressed. The assignee has not changed yet at this
    point, so recovery would otherwise queue a run for the old assignee, and
    the new wake would adopt that run.
  - The route fails with 409 `queued_run_reassignment_stop_unconfirmed` only if
    the run is still live after the cancel attempt.
- `server/src/services/heartbeat/queue.ts`: when the stale gate in
  `claimQueuedRun` cancels a run with `issue_assignee_changed`, release the
  issue and promote the parked wakes. This uses `suppressImmediateRecovery`
  and `deferredPostCommitEffects`, because the code runs under the agent start
  lock.
- `server/src/modules/run-dispatch/adapters/postgres.ts`: a queued legacy run
  that the gate cancels before it ever started records
  `executionRecovery: { kind: "bootstrap", providerWorkStarted: false }`. This
  is the same evidence `run-lifecycle.ts` writes for that case.
- Tests: `server/src/__tests__/heartbeat-reassign-queued-run.test.ts`. The
  watchdog mock in `issue-agent-mutation-ownership-routes.test.ts` returned
  another agent's running run for the new queued-run selection; it now returns
  no rows, as a real database would.

## Review Findings

An independent review of the first version found the following:

| # | Finding | Status |
|---|---|---|
| 1 | The release after a stale-gate cancel ran for every errorCode, so it could block native runs or start recovery for unrelated gate outcomes. | Fixed. Only `issue_assignee_changed` releases. |
| 2 | That release ran under the agent start lock and applied its effects inline. | Fixed. Recovery is suppressed and effects are deferred. |
| 3 | Stopping the running run could start a queued run before it was selected. | Fixed. Queued runs are selected first. |
| 4 | A run that finished on its own made the reassignment fail with 409. | Fixed. The 409 is raised only when the run is still live. |
| 5 | The cancel runs before the issue update. If the update fails, the old assignee's queued runs are gone and recovery was suppressed. | Open. See question 1. |
| 6 | Native queued runs in the route cancel may block the issue during release. | Open. See question 2. |
| 7 | Skipping all comment wakes kept the bug when the holder was an owner comment wake. | Fixed. Only mention and `interaction_pending` wakes are skipped. |
| Tests | The negative test passed even without the skip list. | Fixed. It now includes a mention wake of the previous assignee, and the tests assert the gate errorCode and that no recovery run is queued. |

The review also confirmed these points:
- The bootstrap guard matches `run-lifecycle.ts`.
- Retries do not copy `executionRecovery` from their source run, so the evidence cannot hide earlier provider work.
- A second release does not promote the wake twice.

## Verification

Embedded Postgres refuses to run as root, so the suites ran as the `postgres`
user:

```sh
cd server && runuser -u postgres -- env HOME=/tmp/pgtest-home TMPDIR=/tmp/pgtest-tmp \
  bash -c 'cd /home/user/paperclip/server && npx vitest run <files>'
```

- On unmodified code, the new tests fail for path (a) and path (b). The negative test passes.
- With the fix, these suites pass:
  - Batch 1, 6 files, 273 tests:
    - heartbeat-reassign-queued-run
    - issue-agent-mutation-ownership-routes
    - heartbeat-lock-release-on-reassignment
    - heartbeat-stale-queue-invalidation
    - heartbeat-retry-scheduling
    - human-directed-work
  - Batch 2, 11 files, 468 tests:
    - heartbeat-workspace-busy
    - heartbeat-queued-run-claim-isolation
    - run-dispatch adapter, use-cases and policy
    - native task-reassignment
    - explicit-native-continuation
    - issue-assignee-invokability-routes
    - issue-stale-execution-lock-routes
    - heartbeat-dependency-scheduling
    - heartbeat-scheduling-suppression
- `pnpm --filter @paperclipai/server typecheck` passes.
- Not run: the full monorepo typecheck, `pnpm test:run` and `pnpm build`.

## Open Questions

1. Should the queued-run cancel move after the issue update commits? That
   would protect the old assignee's queued work if the update fails, and
   recovery would no longer need to be suppressed. It would also change the
   ordering the existing running-run cancel uses.
2. For native queued runs, should the route cancel pass the same
   `reassignmentStopConfirmed` marker as the running-run cancel, or skip native
   runs altogether?
3. Known gaps that this change leaves as they were:
   - Reassignments with the `mcp_oauth` source skip this route block and rely
     on the stale gate. That gate needs the old agent to be invokable and to
     have a free slot.
   - A retry that has reached the failure limit still holds promotion.
   - The legacy fallback that adopts any queued run on the issue as the holder
     is unchanged. It is the deeper cause and affects more than reassignment.
