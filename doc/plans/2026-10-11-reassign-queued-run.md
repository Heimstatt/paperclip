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

- `server/src/routes/issues.ts`: reassignment through the issue route.
  - Before the running run is stopped, select the previous assignee's queued
    legacy runs for the issue whose wake reason shows the agent was woken as
    the issue's owner (see "Wake-Reason Classification"). The selection comes
    first because that stop frees a slot that could start one of them.
  - Nothing is selected while the previous assignee is the current participant
    of a pending review stage. The queued-run gate keeps those runs too.
  - Native runs are not selected. A native run is cancelled only through an
    audited native session decision, which a queued run does not have yet.
    The queued-run gate cancels it at claim instead.
  - The selected runs are cancelled only after the issue update has committed
    and the assignee really changed, through the same `heartbeat.cancelRun`
    path used for started runs (errorCode `issue_reassigned`). If the update
    fails, the queued work stays in place. Because the assignee is already the
    new agent, the release queues no recovery for the old one and needs no
    suppression.
  - A cancel that fails or leaves the run live is logged and does not fail the
    request: the reassignment has committed, and the queued-run gate cancels
    the run and promotes the new wake.
- `server/src/services/reassignment-ownership.ts`: the positive list of
  ownership wake reasons, and the rules for the mixed ones.
- `server/src/services/heartbeat/queue.ts`: when the stale gate in
  `claimQueuedRun` cancels a run with `issue_assignee_changed`, release the
  issue and promote the parked wakes. This uses `suppressImmediateRecovery`
  and `deferredPostCommitEffects`, because the code runs under the agent start
  lock.
- `server/src/modules/run-dispatch/adapters/postgres.ts`: the gate records
  `executionRecovery: { kind: "bootstrap", providerWorkStarted: false }` only
  for `issue_assignee_changed` on a legacy run with no evidence of a claim, a
  start, a process, a provider session or an earlier attempt:
  - claim and start: `startedAt`, `executionStage`, `controllerBootId` (the
    claim UPDATE writes the last two, `legacyControllerClaim`)
  - process: `processPid`, `processGroupId`, `processStartedAt`
  - provider and session: `externalRunId`, `sessionIdAfter`
  - retry history: `retryOfRunId`, `scheduledRetryAttempt`,
    `scheduledRetryReason`, `processLossRetryCount`

  The legacy reconciliation classifier only trusts this marker after its
  workspace-recovery and failure-retry checks, so an earlier attempt can never
  be hidden behind it. Every other gate outcome keeps its previous behaviour.
- Tests:
  - `server/src/__tests__/heartbeat-reassign-queued-run.test.ts`: integration
    tests through the real route and queue.
  - `server/src/services/reassignment-ownership.test.ts`: the classification.
  - `server/src/modules/run-dispatch/adapters/postgres.test.ts`: the evidence
    marker.
  - `issue-agent-mutation-ownership-routes.test.ts`: the watchdog mock returned
    another agent's running run for the new queued-run selection; it now
    returns no rows, as a real database would.

## Wake-Reason Classification

The route cancels a queued run only when its `contextSnapshot.wakeReason`
shows that the producer picked the agent as the issue's owner. Owner means
either the assignee, or the same agent continuing, retrying or recovering its
own execution. The list is positive: an unknown, missing or caller-supplied
reason is never cancelled.

The classification comes from the producers of each reason, not from its
name. `wakeReason` is either set by the producer or defaults to the wakeup
`reason` (`server/src/services/heartbeat/run-preparation.ts:1689`).

### Ownership: every producer targets the owner

- **Sent to the assignee of the issue in the run context:**
  - `issue_assigned`: `queueIssueAssignmentWakeup` targets
    `issue.assigneeAgentId`. Other producers (runner tool authority, dot-runner
    broker, recovery) guard on the assignee.
  - `issue_checked_out`: checkout makes the agent the assignee.
  - `issue_status_changed`:
    - The route targets `issue.assigneeAgentId` (`routes/issues.ts` PATCH and
      the stalled-review decision).
    - The native status-decision effects target the run's own agent.
    - The one producer that picks another agent, the `bind_blocker` effect,
      is dropped by the wake-request relay in `heartbeat/queue.ts` unless that
      agent is the current assignee.
    - So any queued run with this reason was the assignee's.
  - `issue_commented` and `issue_reopened_via_comment`: every producer targets
    the assignee or an owner checked against the assignee (comment route,
    question-response, tool-action and connection-intent delivery,
    conversations, chat channels).
  - `issue_children_completed` and `issue_blockers_resolved`: the parent or
    dependent issue's assignee, with the context issue set to that issue.
  - `execution_changes_requested`: `returnAssignee`, the executor taking the
    issue back.
  - `issue_tree_restored`, `issue_tree_resumed`,
    `issue_recovery_action_restored`, `issue_review_path_lost`,
    `issue_monitor_due`, `issue_monitor_recovery`,
    `issue_monitor_recovery_issue`, `status_card_update_assigned`,
    `status_card_compile_assigned`, `summary_slot_generation_requested`,
    `secret_proposal_resolved`, `email_received`, `chat_task_completed`,
    `skill_test_run_created`, `goal_control`: each targets the assignee or an
    owner checked against it.
- **The same agent continuing its own work:**
  - `run_liveness_continuation` and `finish_successful_run_handoff`: both
    require `issue.assigneeAgentId === run.agentId`.
  - `issue_continuation_needed` and `issue_assignment_recovery`: release
    recovery requires the assignee to be the run agent (`wake-queue` use cases,
    `immediateApplies`). Stranded recovery targets the assignee. The one
    stranded-recovery path that can target a review participant is covered by
    the review-stage rule below.
  - `issue_disposition_repair`, `provider_quota_recovery`: the assignee or the
    return owner.
  - `max_turns_continuation_retry`: needs the issue `in_progress` and locked
    by the source run.
  - `interaction_continuation_infra_retry`: needs the source to be a resolved
    interaction continuation, which only the assignee may run.
  - `native_safe_replacement`: the insert guard requires
    `task.assigneeAgentId === run.agentId`.

### Mixed reasons, decided by a recorded fact

- `workspace_busy_retry`, `ai_connection_busy_retry` and
  `ai_connection_pool_retry`: each records whether the agent was the assignee
  when the wait began (`workspaceBusyDeferredWhileAssignee` or
  `aiConnectionBusyDeferredWhileAssignee`). The run counts as ownership only
  when that flag is `true`. The stale gate uses the same flags
  (`isNonAssigneeWorkspaceBusyRetry`).
- `transient_failure_retry`, `missing_issue_comment` and
  `native_provider_overloaded`: these keep the source run's agent and
  overwrite its wake reason without recording an assignee flag. They follow
  `retryOfRunId` to the source run and take that run's class, for up to five
  hops. If the source cannot be found, the run is not cancelled.
- Pending review stage: during a review stage the issue's assignee is the
  reviewer or approver (`buildPendingStagePatch`). When the previous assignee
  is the current participant of a pending stage, none of its runs are
  cancelled. This mirrors the gate's `isCurrentReviewParticipant` exemption.

### Not ownership: never cancelled

| Reason | Why |
|---|---|
| `interaction_pending` | Targets `interaction.addresseeAgentId` (`routes/issues.ts`, interaction create). |
| `issue_unblock_requested` | Targets the unblock owner, not checked against the assignee. |
| `execution_review_requested`, `execution_approval_requested` | Target `currentParticipant`, the reviewer or approver. |
| `native_completion_review`, `execution_review_participant_recovery` | Target the review participant. |
| `decision_decided`, `decision_expired`, `decision_cancelled` | Target the decision's origin agent. |
| `task_watchdog_stopped_subtree` | Targets the watchdog. Its context issue is the watchdog issue. |
| `issue_comment_mentioned` | Has no producer that creates a run: `enqueueWakeup` returns null for it (`heartbeat/queue.ts:2138`). |
| `approval_approved` | Mixed. One producer wakes the requester, another the assignee, and nothing on the run separates them reliably, so it is left alone. |
| `retry_failed_run` | Mixed. The manual retry route allows a native reviewer as well as the assignee. |
| Any other reason | Not cancelled. This includes the free-form reasons from the agent wake route and from plugins. |

Comment wakes differ from the stale gate on purpose. The gate keeps a
non-assignee's `issue_commented` wake when it carries a comment id. The route
cancels the previous assignee's comment wake, because every producer sent it
to that agent as the owner. The new assignee's assignment wake picks up the
issue, comments included.

## Review Findings

An independent review of the first version found the following:

| # | Finding | Status |
|---|---|---|
| 1 | The release after a stale-gate cancel ran for every errorCode, so it could block native runs or start recovery for unrelated gate outcomes. | Fixed. Only `issue_assignee_changed` releases. |
| 2 | That release ran under the agent start lock and applied its effects inline. | Fixed. Recovery is suppressed and effects are deferred. |
| 3 | Stopping the running run could start a queued run before it was selected. | Fixed. Queued runs are selected first. |
| 4 | A run that finished on its own made the reassignment fail with 409. | Fixed. The 409 is raised only when the run is still live. |
| 5 (F2) | The cancel runs before the issue update. If the update fails, the old assignee's queued runs are gone and recovery was suppressed. | Fixed. The cancel runs after the update commits. Tested with an update rejected after the selection; the test fails on the previous ordering. |
| 6 (native) | Native queued runs in the route cancel may block the issue during release. | Settled. The route leaves native runs to the gate. Tested: no reconciliation hold, no recovery action, and the new assignee's wake is promoted. |
| F3 | The bootstrap evidence was written for every queued stale-gate outcome. | Fixed. Only `issue_assignee_changed` on an unclaimed first attempt. Adapter tests cover a retry, a previously claimed run and another gate reason. |
| 7 | Skipping all comment wakes kept the bug when the holder was an owner comment wake. | Fixed. A positive ownership list derived from the producers replaces the skip list (see below). |
| Tests | The negative test passed even without the skip list. | Fixed. The negative test now uses the previous assignee's own `interaction_pending` wake, created through the real interaction route. The tests also assert the gate errorCode and that no recovery run is queued. |

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
- After the switch to the positive ownership list:
  - `reassignment-ownership.test.ts`, `heartbeat-reassign-queued-run.test.ts`
    and `issue-agent-mutation-ownership-routes.test.ts`: 3 files, 151 tests
    passed.
  - The fifteen files of the two batches above, rerun together on this
    change: 15 files, 595 tests passed.
- After the F2, F3 and native changes:
  - `heartbeat-reassign-queued-run.test.ts`: 5 tests passed. The failed-update
    test fails on the previous cancel-before-update ordering (the run is
    cancelled with `issue_reassigned` although the update was rejected).
  - `run-dispatch/adapters/postgres.test.ts`: 50 tests passed, including the
    four evidence-marker cases.
  - The full regression set was rerun on this change; see the following
    commit.
- `pnpm --filter @paperclipai/server typecheck` passes.
- Not run: the full monorepo typecheck, `pnpm test:run` and `pnpm build`.

## Open Questions

1. Known gaps that this change leaves as they were:
   - Reassignments with the `mcp_oauth` source skip this route block and rely
     on the stale gate. That gate needs the old agent to be invokable and to
     have a free slot.
   - A retry of an earlier attempt that the gate cancels for a reassignment
     gets no evidence marker, so its deferred wake still waits for
     reconciliation or the next wake.
   - The legacy fallback that adopts any queued run on the issue as the holder
     is unchanged. It is the deeper cause and affects more than reassignment.
   - No current producer leaves a native run queued. The native test pins the
     outcome should one appear.
