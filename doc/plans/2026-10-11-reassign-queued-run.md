# Reassignment With a Queued Previous-Assignee Run

Notes for the fix to public issue paperclipai/paperclip#14879: "Reassigning an
issue does not cancel the previous assignee's queued run, so the new
assignee's wake stays deferred".

- Branch: `fix/14879-reassign-queued-run`
- Started from: `e733bddc45e00efb1819fffa8677f7b0d07802c5` (`master`)
- Rebased onto: `04d8eaef45ac05f684487f422e158973616fff54`
  (`fix/15483-prestart-cancel-not-reconcile`, fork PR #2, the fix for
  paperclipai/paperclip#15483). This branch is now stacked on that fix.

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
    the issue's owner (see "Wake-Reason Classification").
  - Nothing is selected while the previous assignee is the current participant
    of a pending review stage. The queued-run gate keeps those runs too.
  - Native runs are not selected. A native run is cancelled only through an
    audited native session decision, which a queued run does not have yet.
    The queued-run gate cancels it at claim instead.
  - Queue fence: stopping the running run does not start the previous
    assignee's queue. `cancelRun` collects the release's post-commit effects
    instead (`deferredPostCommitEffects`). The route applies them and restarts
    that agent's queue when the response closes, on every path.
  - Atomic cancel: the selected runs are cancelled as the last step of the
    issue update transaction, through the same legacy terminalization as
    `setRunStatus`. They are cancelled exactly when the new assignee commits.
    If the update fails, they stay queued. If one was claimed meanwhile by
    another path, the transaction fails with 409
    `queued_run_started_before_cancel` and nothing changes.
  - After commit, the route publishes the status change and completes the wake,
    event and release side effects of the cancelled runs.
- `server/src/services/heartbeat.ts`, `heartbeat/run-control.ts`,
  `heartbeat/run-lifecycle.ts`: `cancelRun` accepts
  `deferredPostCommitEffects`. New service methods `cancelQueuedRunsInTx`,
  `settleCancelledQueuedRuns` and `resumeAfterDeferredCancellation` carry the
  transactional cancel and the deferred restart.
- `server/src/services/pre-dispatch-review-wait.ts` (shared with the #15483
  fix): one pre-dispatch cancel predicate, `isPreDispatchCancel`, with
  `isPreDispatchCancelVerified` for the retained evidence. See "Stacking on
  the #15483 fix" below.
- The transactional queued-run cancel stamps a reassignment pre-dispatch
  cancel receipt (`stopReason: "issue_reassigned"`,
  `timeoutSource: "reassignment_queue_cancel"`) and writes no bootstrap marker
  of its own. The shared verifier decides whether the run needs
  reconciliation, at terminalization and at release.
- `server/src/services/reassignment-ownership.ts`: the positive list of
  ownership wake reasons, and the rules for the mixed ones.
- `server/src/services/heartbeat/queue.ts`: when the stale gate in
  `claimQueuedRun` cancels a run with `issue_assignee_changed`, release the
  issue and promote the parked wakes. This uses `suppressImmediateRecovery`
  and `deferredPostCommitEffects`, because the code runs under the agent start
  lock. With the #15483 verifier the drain promotes behind a legacy holder that
  never started, as well as behind a native holder.
- `server/src/modules/run-dispatch/index.ts`: exports
  `QUEUED_RUN_STALENESS_ERROR_CODES`, so the verifier imports it through the
  module index (`pnpm check:module-boundaries`).
- Tests:
  - `server/src/__tests__/heartbeat-reassign-queued-run.test.ts`: integration
    tests through the real route and queue.
  - `server/src/services/reassignment-ownership.test.ts`: the classification.
  - `issue-agent-mutation-ownership-routes.test.ts`: the watchdog mock returns
    no rows for the queued-run selection, as a real database would.

## Stacking on the #15483 fix

### Conflict in `pre-dispatch-review-wait.ts`

Both branches had built the same "never dispatched" check. The combined file
keeps one predicate:

- The #15483 version is the base: `isPreDispatchCancel`,
  `isPreDispatchReviewWait` and `isPreDispatchCancelVerified`, with the
  pre-dispatch codes derived from `QUEUED_RUN_STALENESS_ERROR_CODES`.
- Underneath, the dispatch-field check and the retained-evidence check exist
  once each, inside the module (`hasNoDispatchEvidenceOnRow`,
  `hasVerifiedNoDispatchEvidence`). They are no longer exported.
- The only extension is a third cancel source,
  `reassignment_queue_cancel`, valid only with `issue_reassigned`. A source is
  accepted only with its own codes: the queued-run gate with the staleness
  codes except `execution_reconciliation_required`, the claim-time dependency
  gate with `issue_dependencies_blocked`, and the reassignment cancel with
  `issue_reassigned`.
- Both kinds of cancel reach the predicate through the same call site:
  `legacyExecutionNeedsReconciliationWithEvidence`, which the legacy
  terminalization and the release pre-drain both use. The reassignment cancel
  no longer writes its own bootstrap marker.
- The staleness codes are read at call time, not at module load: the
  run-dispatch index can be mid-evaluation when this module loads through an
  import cycle.

### Retry case: one behaviour

Before the rebase the two branches disagreed about a queued retry that never
ran:

- The #15483 fix drops the reconciliation hold for a gate-cancelled run that
  the verifier proves never dispatched, even when its failure-retry budget is
  spent (`scheduledRetryAttempt >= 2`).
- This branch wrote a bootstrap marker for the reassignment cancel. The
  synchronous classifier checks the retry budget before the marker, so for a
  spent budget the hold stayed. The outcome therefore depended on which path
  cancelled the run.

The combined code follows the #15483 behaviour for both paths: a verified
never-dispatched cancel needs no reconciliation, whatever the retry count.

Why:

- A reconciliation hold protects against unknown provider actions of that
  run. The verifier proves the run has none: no claim field, no lease, no
  execution event.
- The earlier failed attempts were classified when they themselves ended.
  Their unknown outcomes are recorded on their own rows. Keeping a hold on
  the cancelled retry adds no protection for them.
- The retry budget limits automatic retries. It is enforced where retries are
  scheduled, not by holding a run that never ran.
- In the reassignment case, keeping the hold blocks the new assignee, which is
  the bug this branch fixes.

If the verifier sees any dispatch evidence, the hold stays, for retries and
first attempts alike. A test covers a never-run retry with
`scheduledRetryAttempt: 2` whose source failed with `process_lost`.

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
| 5 (F2) | The cancel runs before the issue update. If the update fails, the old assignee's queued runs are gone and recovery was suppressed. | Fixed. The cancel is part of the update transaction. Tested with an update rejected after the selection; the test fails on the cancel-before-update ordering. |
| F2, round 3 | Stopping the active run starts the old agent's queue, so a selected queued run can be claimed before the reassignment commits. | Fixed. The stop defers the agent's queue start until the response ends, and the cancel is atomic with the update. Tested with a queued run that becomes claimable during the stop; on the previous code the stop sends it through the claim path before the commit. A direct test shows a run claimed by another path rolls the update back. |
| 6 (native) | Native queued runs in the route cancel may block the issue during release. | Settled. The route leaves native runs to the gate. Tested: no reconciliation hold, no recovery action, and the new assignee's wake is promoted. |
| F3 | The bootstrap evidence was written for every queued stale-gate outcome. | Resolved by removal (round 3 decision). The gate writes no marker on this branch; the #15483 verifier decides. The stale-gate test now asserts only what this branch guarantees. |
| F3, transactional cancel | The transactional queued-run cancel wrote the bootstrap evidence when only `startedAt` and `processPid` were empty. | Fixed. It uses the shared verified pre-dispatch predicate. Negative tests cover each row field, an unsafe archive, a held lease and an execution event; 12 of them fail on the previous condition. A coordinator implies `nativeIssueId` through its foreign key, so the `nativeIssueId` case covers it. |
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

- `heartbeat-reassign-queued-run.test.ts` (7 tests):
  - reassignment through the route cancels the queued `issue_assigned` run
    and admits the new assignee's wake, with no recovery for the old one
  - a queued run that becomes claimable during the active-run stop is
    cancelled by the reassignment and never starts; on the previous code the
    stop sends it through the claim path before the commit
  - a queued run another path already started rolls the reassignment back
    with 409
  - a rejected update keeps the queued run; this fails on the
    cancel-before-update ordering
  - the queued-run gate cancels a stale legacy holder and frees the lock
  - a native queued run is left to the gate, with no reconciliation hold and
    with the new wake promoted (fixture)
  - the previous assignee's `interaction_pending` wake survives
- Full regression set on the final code: 20 files, 772 tests passed. It
  includes the reassignment, classification, ownership-route,
  invokability-route, stale-queue, retry, workspace-busy, claim-isolation,
  run-dispatch, native reassignment and cancellation, terminalize-before-
  release, dependency and scheduling suites.
- After the shared pre-dispatch predicate (F3 on the transactional cancel):
  24 files, 1262 of 1263 tests passed. The set adds the suites that use the
  verifier: `legacy-execution-recovery`, `wake-queue/adapters/postgres`,
  `heartbeat-process-recovery` and `disposition-repair`. The one failure,
  `heartbeat-process-recovery` "redacts opaque environment-bound credentials
  from Sentry diagnostics: result", also fails with the base versions of
  every changed source file, so it is not caused by this branch.
- `pnpm --filter @paperclipai/server typecheck` passes.
- After the rebase onto the #15483 fix (`04d8eae`), at head `f7a3ab7`:
  - `pnpm check:module-boundaries`: passes. On `04d8eae` alone it fails
    (`pre-dispatch-review-wait.ts` imports `run-dispatch/domain/policy.js`);
    this branch imports through the module index.
  - `pnpm --filter @paperclipai/server typecheck`: passes.
  - Focused tests of both branches plus the regression set, 24 files:
    1282 of 1283 tests pass. The #15483 files are
    `legacy-execution-recovery.test.ts`, `wake-queue/adapters/postgres.test.ts`
    and `heartbeat-dependency-scheduling.test.ts`. The one failure is the
    `heartbeat-process-recovery` Sentry redaction test. It also fails with the
    `04d8eae` versions of every source file this branch changes, and with the
    `e733bdd` versions, so neither branch causes it.
  - `heartbeat-reassign-queued-run.test.ts`: 23 tests pass (the gate test was
    corrected after the first run of the set, then rerun alone).
- Not run: the full monorepo typecheck, `pnpm test:run` and `pnpm build`.
- GitHub Actions do not run on this fork.

## Open Questions

1. `setRunStatus` and `setRunStatusFromLive` in
   `server/src/services/heartbeat/run-lifecycle.ts` predate this branch and
   still write the bootstrap evidence for any cancelled queued non-native run
   with empty `startedAt` and `processPid`. Should they use the shared
   verified predicate too? That changes behaviour for every queued-run cancel,
   not only reassignment.
2. Known gaps that this change leaves as they were:
   - Behind a cancelled legacy holder, the deferred wake is promoted only with
     the #15483 verifier. On this branch alone it waits for the next wake.
   - Reassignments with the `mcp_oauth` source skip this route block and rely
     on the stale gate. That gate needs the old agent to be invokable and to
     have a free slot.
   - The queue fence covers starts caused by the reassignment itself. A claim
     from another path in that window makes the reassignment fail with 409
     instead of starting work under the old assignment.
   - The legacy fallback that adopts any queued run on the issue as the holder
     is unchanged. It is the deeper cause and affects more than reassignment.
   - No current producer leaves a native run queued, or a queued run beside a
     running holder on the same issue. The tests for both use fixtures.

## Upstream Publication (Drafts, Not Published)

Nothing in this section is published. The two pull requests are stacked:
the reassignment change depends on the pre-dispatch cancel change.

### Draft 1: pre-dispatch cancels need no reconciliation (paperclipai/paperclip#15483)

Base: `master`. Commits: `490d44d`, `04d8eae`, and the module-boundary fix
from this branch if it is moved down (see "Before publication" below).

```markdown
## Thinking Path

> - Paperclip is the open source app people use to manage AI agents for work
> - The heartbeat dispatcher cancels a queued run before it starts when the run lost its target, for example after a reassignment or while dependencies are blocked
> - The legacy reconciliation classifier treats any cancelled legacy run without start evidence as an unknown provider failure
> - Thus a run that never started leaves a permanent reconciliation hold on the issue, and deferred wakes do not get promoted
> - This pull request generalizes the existing pre-dispatch review-wait receipt to every dispatcher staleness code and to the claim-time dependency gate, and it uses the evidence-backed check when it decides about reconciliation
> - The benefit is that a dispatcher pre-start cancel releases the issue, while a run with any start evidence keeps the hold

## Linked Issues or Issue Description

Fixes: paperclipai/paperclip#15483

## What Changed

- `server/src/services/pre-dispatch-review-wait.ts`: `isPreDispatchCancel` accepts every queued-run staleness code except `execution_reconciliation_required` from the queued-run gate, and `issue_dependencies_blocked` from the claim-time dependency gate. `isPreDispatchCancelVerified` also requires no finalization coordinator, no held environment lease and no execution event. `isPreDispatchReviewWait` keeps its behaviour.
- `server/src/services/legacy-execution-recovery.ts`: `legacyExecutionNeedsReconciliationWithEvidence` uses the verified pre-dispatch cancel check.
- `server/src/modules/run-dispatch/domain/policy.ts`: the staleness codes are one exported list, `QUEUED_RUN_STALENESS_ERROR_CODES`. The module index exports it.
- Tests for each staleness code, the dependency gate, a release that promotes saved input after a pre-start cancel, a never-run retry with a spent failure budget, and a cancelled run that had started.

## Verification

- `pnpm check:module-boundaries`
- `cd server && npx vitest run src/services/legacy-execution-recovery.test.ts src/modules/wake-queue/adapters/postgres.test.ts src/__tests__/heartbeat-dependency-scheduling.test.ts`
- `pnpm --filter @paperclipai/server typecheck`
- Embedded Postgres does not start as root. Run the tests as a non-root user.

## Risks

- A never-run retry with a spent failure budget no longer keeps a hold. The earlier failed attempts keep their own reconciliation decisions.
- A run with any start, process, session, lease or execution-event evidence keeps the hold.

## Model Used

- Claude (Anthropic) through Claude Code, with tool use and code execution.

## Checklist

(Fill in at publication.)
```

### Draft 2: reassignment cancels the previous assignee's queued runs (paperclipai/paperclip#14879)

Base: the branch of Draft 1. Commits: every commit of this branch after
`04d8eae`.

```markdown
## Thinking Path

> - Paperclip is the open source app people use to manage AI agents for work
> - The heartbeat queue starts agent runs and controls which run holds the execution lock of an issue
> - When a user reassigns an issue, Paperclip stops the running run of the previous assignee, but it keeps the queued runs of that agent
> - A queued run does not hold the issue lock. Thus the wake of the new assignee adopts the old queued run as lock holder and waits as `deferred_issue_execution`
> - This pull request cancels the queued ownership runs of the previous assignee in the same transaction as the reassignment, and it promotes the waiting wake when the queued-run gate cancels a stale holder
> - The benefit is that a reassignment starts the new assignee without a wait for the previous agent

## Linked Issues or Issue Description

Fixes: paperclipai/paperclip#14879

Depends on: the pull request for paperclipai/paperclip#15483 (Draft 1).

## What Changed

- `server/src/routes/issues.ts`: on reassignment, select the queued legacy runs of the previous assignee whose wake reason shows ownership. Stopping the running run does not start that agent's queue until the response ends. The selected runs are cancelled as the last step of the issue update transaction. A rejected update keeps them queued. A run that another path started rolls the update back with 409.
- `server/src/services/reassignment-ownership.ts`: a positive list of ownership wake reasons, derived from the producers of each reason.
- `server/src/services/heartbeat.ts`, `heartbeat/run-control.ts`, `heartbeat/run-lifecycle.ts`: `cancelRun` accepts `deferredPostCommitEffects`; new methods `cancelQueuedRunsInTx`, `settleCancelledQueuedRuns` and `resumeAfterDeferredCancellation`.
- `server/src/services/pre-dispatch-review-wait.ts`: a reassignment cancel source, `reassignment_queue_cancel`, valid only with `issue_reassigned`. The shared verifier decides about reconciliation for this cancel too.
- `server/src/services/heartbeat/queue.ts`: when the queued-run gate cancels a run because the assignee changed, release the issue and promote the waiting wakes.
- Tests through the real route and queue, a classification unit test, and one evidence test for each dispatch field.

## Verification

- `pnpm check:module-boundaries`
- `cd server && npx vitest run src/__tests__/heartbeat-reassign-queued-run.test.ts src/services/reassignment-ownership.test.ts src/services/legacy-execution-recovery.test.ts`
- `pnpm --filter @paperclipai/server typecheck`
- Embedded Postgres does not start as root. Run the tests as a non-root user.

## Risks

- A claim from another path between the stop of the active run and the update commit makes the reassignment fail with 409.
- Reassignments with the `mcp_oauth` source skip the route block and depend on the queued-run gate.
- Two test states have no current natural producer: a native queued run, and a queued run beside a running holder on the same issue. These tests use fixtures.

## Model Used

- Claude (Anthropic) through Claude Code, with tool use and code execution.

## Checklist

(Fill in at publication.)
```

### Before publication

- The module-boundary violation is in the #15483 code (`pre-dispatch-review-wait.ts`
  imports `run-dispatch/domain/policy.js`). On this branch it is fixed in a
  later commit. For Draft 1 to pass `pnpm check:module-boundaries` on its own,
  that fix must move to the #15483 branch.
- The commits listed below carry `Claude-Session` lines. Remove them before
  publication by rewriting history; that is not done yet.

### Commits that carry a `Claude-Session` line

All commits of the stack above `master` (`e733bdd`) carry one. Their
`Co-Authored-By` lines also name a model. Both must be removed before
publication; history is not rewritten yet.

| Commit | Subject | Session |
|---|---|---|
| `490d44d` | fix(server): dispatcher pre-start cancels no longer require reconciliation | the #15483 session |
| `04d8eae` | fix(server): cover claim-time dependency cancel and tighten pre-dispatch receipt | the #15483 session |
| `e9a447e` | Cancel previous assignee's queued runs on reassignment | this session |
| `27afab6` | Keep watchdog reassignment mock free of queued runs | this session |
| `3d34342` | Narrow stale-gate promotion and harden reassignment cancel | this session |
| `021b3d4` | Add notes for the reassignment queued-run fix | this session |
| `61cb705` | Cancel only queued runs woken as the issue owner on reassignment | this session |
| `b70cf63` | Record regression results for the ownership classification | this session |
| `30c3294` | Cancel queued runs after the reassignment commits; narrow evidence | this session |
| `8bf1235` | Record regression results for the post-commit cancel change | this session |
| `2598ed3` | Fence the old assignee's queue and cancel queued runs atomically | this session |
| `6242e57` | Hold the agent queue only when a start was deferred | this session |
| `77286ca` | Record verification for the queue fence and atomic cancel | this session |
| `d196dbf` | Gate the queued-cancel bootstrap evidence on a verified predicate | this session |
| `47d33a8` | Record verification for the shared pre-dispatch predicate | this session |
| `7ffe943` | Use the #15483 pre-dispatch verifier for the reassignment cancel | this session |
| `f7a3ab7` | Expect the promoted run to take the lock after the gate cancel | this session |
| (next) | the commit that adds this list | this session |
