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
  run whose wake reason shows the agent was woken as the issue's owner is
  cancelled through the same `heartbeat.cancelRun` path used for started runs
  (errorCode `issue_reassigned`). See "Wake-Reason Classification" below.
  - Nothing is cancelled while the previous assignee is the current
    participant of a pending review stage. The queued-run gate keeps those
    runs too.
  - Immediate recovery is suppressed. The assignee has not changed yet at this
    point, so recovery would otherwise queue a run for the old assignee, and
    the new wake would adopt that run.
  - The route fails with 409 `queued_run_reassignment_stop_unconfirmed` only if
    the run is still live after the cancel attempt.
- `server/src/services/reassignment-ownership.ts`: the positive list of
  ownership wake reasons, and the rules for the mixed ones.
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
| 5 | The cancel runs before the issue update. If the update fails, the old assignee's queued runs are gone and recovery was suppressed. | Open. See question 1. |
| 6 | Native queued runs in the route cancel may block the issue during release. | Open. See question 2. |
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
  - The two batches above were rerun on this change; see the following
    commit.
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
