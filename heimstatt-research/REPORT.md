# Report: lease-race handoff wake, successor candidates on current master

Date: 2026-10-30. Base: upstream `master` at `f5e5b05a33` ("Preserve native workspace recovery
across Stop and sandbox reuse"). Nothing was posted publicly. No PR was opened and no comment was made.

## TL;DR

- **The bug is still on master.** In the control run, 8 of 9 cases fail. The only pass is "stale stage → no
  run", and it passes only because nothing ever runs.
- **PR 16966 (parked ownership wait) is the only candidate that passes every case**: plain handoff, review
  stage, return leg (`changes_requested`), admission failure, suppression, and 30-minute and 24-hour outages.
  Its own 25 tests also pass on master.
- 15019 covers the handoff and return legs but **loses the handoff after 15 minutes**. This confirms the open
  question from the brief.
- 13880 covers only review-stage handoffs (no plain reassignment, no return leg).
- Fork 211 only works in the moment of a successful release. It has no retry, no suppression handling and no
  return leg.
- **Recommendation:** use 16966 as the successor. A clean port with tests is on branch
  `research/lease-race-successor-impl`. The receipts that are already stuck as `skipped` need a one-off
  remediation (see Risks).

## Method

1. I fetched `master`, `pull/15019/head` (`84defd0b25`), `pull/13880/head` (`bf160490df`),
   `pull/16966/head` (`3803bcb898`) and fork `phenix3443/paperclip` `pull/211/head` (`f2590ef1f7`).
2. I put each candidate on `master` as branch `cand/<n>`. Exported diffs:
   `ports/<n>-on-master.diff`.
3. I ran three kinds of tests (Embedded Postgres, only the relevant files):
   - **As written:** our `heimstatt-13532-stage-wake.test.ts` (S1–S3) and
     `15019-changes-requested-regression.patch`, unchanged.
   - **Each candidate's own tests.**
   - **Portable harness:** `harness/heimstatt-portable.test.ts`. The same 9 outcome cases run for every
     candidate. Each candidate is reached through its own two entry points: `onRelease` (the cleanup hook)
     and `periodic` (the scheduler tick, worker or startup). See `harness/adapters/`. I added this because
     S1–S3 call `readmitLeaseBlockedHandoffs`, which is 15019's internal API, and expect a `skipped`
     receipt. That is 15019's model, so S1–S3 cannot judge other approaches fairly.
4. As the brief requires, a skipped test counts as a failure. Note: in a root container, every Embedded
   Postgres suite reports **skipped**, because Postgres refuses to run as root. I ran all suites as an
   unprivileged user. No result below is a skip.

### Finding on our fixture

S1–S3 (and the regression patch) write an `issues.executionState` without `currentStageIndex` and
`lastDecisionId`. That state fails `issueExecutionStateSchema`, which the shared validator enforces.

- 211 and 16966 parse the state strictly (`parseIssueExecutionState`), so they treat such a stage as "no
  longer current" and do nothing.
- 15019 and 13880 compare raw JSON fields, so they pass with the incomplete state.

The server only writes schema-valid states, so the harness uses a complete state. The as-written results
stay in the tables, but **our fixture should be corrected**. As it stands it can mark a candidate as failing
for a state that does not occur in production.

## Port onto master

| Candidate | Behind master | Conflicts on master | Changed code paths |
|---|---|---|---|
| 15019 | 966 | 2nd commit: `heartbeat.ts` (`finalizeAgentStatus` was moved out; `reconcileStrandedAssignedIssues` gained an opts param) and `run-preparation.ts` (`WakeupOptions` gained `taskRetryRequestId`). Both are mechanical. | Cleanup hook plus retry pass in `heartbeat.ts`; admission marker in `heartbeat/queue.ts`. The approach applies unchanged. |
| 211 (fork) | 183 commits behind, plus about 5000 fork-only commits | Builds on fork-only infrastructure: `recordRunExecutionReleased`, `executionCleanupSettled`, `modules/wake-queue/receipt-namespace` and the test helper `seedReviewerIntent`. I hooked it into master's `caseHandoffCleanupSettled` release block, dropped the namespace predicate (master has no reviewer-continuation receipts) and inlined a master version of the helper. | Release block in `heartbeat.ts` plus new `heartbeat/released-execution-wake.ts`. |
| 13880 | No common history with current master (the branch is on rewritten history) | Cherry-picks do not apply. I ported it by hand: admission and `resumeQueuedRuns` moved from `heartbeat.ts` to `heartbeat/queue.ts`, and the `issueStateGuard` check gained monitor fields. | Sweep in `resumeQueuedRuns` plus `executionStageId` in the state guard. |
| 16966 | 408 | `delivery-work-notifications.ts` (adds to the queue list) and `queue.ts` (the execution-wait actor check: master dropped the task-retry special case). Typecheck then showed a duplicate import and that master narrowed the `deferBlockedExecution` blocker type with `Pick<…>`. I added an optional `runId`. | Admission parks the wake instead of skipping it (`queue.ts`); resume in `run-control.ts`; cleanup hook in `heartbeat.ts`; worker registration in `index.ts`. |

`tsc --noEmit` for `server` reports no errors in the touched files for any of the four ports. The remaining
errors in the container also occur on master: the `paperclip-runner` vendor package was not built and
`implicit any` errors appear in unrelated files.

## Results

### Portable harness (9 cases, schema-valid state)

| Case | master (control) | 15019 | 211 | 13880 | 16966 |
|---|---|---|---|---|---|
| P1 plain reassignment handoff | fail | pass | pass | **fail** | pass |
| S1 review stage, one run, only one | fail | pass | pass | pass | pass |
| S2 stage moved → no run | pass\* | pass | pass | pass | pass |
| S3 lease held → none, then one | fail | pass | pass | pass | pass |
| R1 return leg `changes_requested` | fail | pass | **fail** | **fail** | pass |
| R2 admission fails, later pass delivers exactly one | fail | pass | **fail** | pass | pass |
| R3 release during suppression | fail | pass | **fail** | pass | pass |
| L1 hook missed, pass after 30 min | fail | **fail** | **fail** | pass | pass |
| L2 hook missed, pass after 24 h | fail | **fail** | **fail** | pass | pass |
| **Total** | 1/9 | 7/9 | 4/9 | 7/9 | **9/9** |

\* passes trivially, because master never starts anything.

### Our cases as written

| Case | 15019 | 211 | 13880 | 16966 |
|---|---|---|---|---|
| S1 | pass | fail (`readmitLeaseBlockedHandoffs` missing) | fail (same) | fail (no `skipped` receipt; the wake is parked as `deferred_issue_execution`) |
| S2 | pass | fail (same) | fail (same) | fail (same) |
| S3 | pass | fail (same) | fail (same) | fail (same) |
| Patch: `changes_requested` re-admit | pass | n/a (lives in 15019's test file) | n/a | n/a |
| Patch: retry after claim | **fail** | n/a | n/a | n/a |
| Patch: recovery after suppression via `resumeQueuedRuns` | **fail** | n/a | n/a | n/a |

The two patch failures appear **identically on the unrebased PR head `84defd0b25`**, so they are not
caused by the port. They encode a different contract than 15019:

- 15019 sets `readmittedAt` only atomically, together with the admission. A failed admission counts
  `readmitAttempts` and leaves `readmittedAt` empty.
- 15019 retries through `retryLeaseHandoffReadmits` (from `reconcileStrandedAssignedIssues`), not through
  `resumeQueuedRuns`.

In the harness, both behaviours (R2, R3) pass for 15019. The statement "all passed on 84defd0b2" in the
brief therefore only holds for the 31 PR tests plus S1–S3, not for the patch.

### Each candidate's own tests (on master)

| Candidate | File | Result |
|---|---|---|
| 15019 | `lease-handoff-readmit.test.ts` (31 PR tests) | 31/31 |
| 211 | `heartbeat-released-execution-wake.test.ts` | 2/2 |
| 13880 | `review-handoff-lease-wake.test.ts` | 5/5 |
| 16966 | `heartbeat-execution-ownership-wait.test.ts` | 25/25 |
| 16966 | `heartbeat-process-recovery.test.ts` and `server-startup-feedback-export.test.ts` (both touched by the PR) | 510/511. The one failure (Sentry redaction, `'ser***REDACTED***ce'`) also fails on unchanged master, so 16966 did not cause it. |

### Regression check for 16966

I found 17 test files on master that cover `execution_owner_active` or `execution_reconciliation_required`
and ran them on both master and `cand/16966`.

- **Both:** 899 passed and 138 failed out of 1037. The failures were identical, test for test (diffed).
- **All 138 failures are in `workspace-recovery.test.ts`.** They come from the container (`tsx` ESM module
  not found), not from the change.
- **Sentry redaction test in `heartbeat-process-recovery.test.ts`:** fails on master too, so it is not a
  regression.

**Result: the 16966 port shows no regression in these files.**

I did **not** run `pnpm -r typecheck`, `pnpm test:run` or `pnpm build` in full. The brief does not require
them, and the container cannot build the `paperclip-runner` vendor package.

## Coverage per approach

| | Handoff leg (plain/stage) | Return leg | Long outage / missed hook | Exactly once | Mechanism |
|---|---|---|---|---|---|
| 15019 | yes / yes | yes | **no**: retry window is 15 min, then the receipt is never selected again | yes (atomic stamp, attempt counter, max 3) | Keeps the terminal `skipped` receipt; hook plus retry pass with a time window |
| 211 | yes / yes | **no** (stage check accepts only `pending`) | **no** (no periodic path) | per release run (idempotency key) | Hook only, at the release event |
| 13880 | **no** / yes | **no** (only `pending` plus `currentParticipant`) | yes (no time window) | yes (claim plus key) | Sweep only, ≥30 s latency |
| 16966 | yes / yes | yes (`wakeRole: executor` against `returnAssignee`) | yes (durable receipt; worker at startup and on deadline) | yes (receipt consumed with the successor run; adopted by later wakes) | Fixes the root cause: the wake is no longer stored as a terminal `skipped` but parked as `deferred_issue_execution` |

## Risks

**16966**

- It is the largest change to admission (`queue.ts`), on the most heavily modified path on master. The
  conflict with the task-retry actor rule shows that later master changes to `executionWaitRequestId` will
  conflict again.
- **Receipts that are already `skipped`** (our 38) are not picked up. The fix only acts on new wakes. We need
  a one-off migration or a manual wake for stuck issues.
- The delivery-work coordinator assumes a single active writer. The PR text explicitly says that
  multi-replica wakeups are not established. Startup reconstruction is the fallback.
- New receipt status for these wakes: `deferred_issue_execution` instead of `skipped`. Dashboards and
  queries that count `execution_reconciliation_required` will see fewer of them.
- I resolved two conflicts by hand: the actor check and the type of `deferBlockedExecution`. The upstream
  author should review both resolutions.

**15019:** The time window drops receipts after downtime or suppression longer than 15 minutes, or after 3
failed attempts. It is also the largest test file for a symptom-level fix.

**211:** If the hook fails or does not run (for example a crash between release and selection), the
handoff is lost. The stage check is too narrow for the return leg. It also depends on fork infrastructure.

**13880:** Stage handoffs only. The latency is at least 30 s plus the tick interval.

## Recommendation

Use **16966** as the basis for the successor. It is the only candidate that fixes the cause: a wake blocked
only by a lease that has not yet been released is no longer treated as a terminal diagnostic. It passes all
outcome cases, including the long outage that 15019 cannot cover by design. If upstream does not take it,
15019's time window could be removed as a fallback. That leaves 15019 still keeping the receipt terminal, so
it is not the better long-term choice.

The branch `research/lease-race-successor-impl` contains:

- master `f5e5b05a33` plus the 16966 port as one commit;
- `server/src/services/lease-race-handoff-wake.test.ts`, which is the 9 harness cases against 16966's entry
  points.

Verification on that branch: `lease-race-handoff-wake.test.ts` and `heartbeat-execution-ownership-wait.test.ts`
pass 34/34. `tsc --noEmit` shows no errors in the touched files.

Before going upstream, decide with the owner:

- remediation of legacy `skipped` receipts;
- attribution to the 16966 author;
- whether the successor should go upstream as a contribution to 16966 or as a separate change.

## Artifacts in this folder

- `REPORT.md`: this report.
- `harness/heimstatt-portable.test.ts`, `harness/adapters/*.ts`, `harness/README.md`.
- `ports/*-on-master.diff`: each candidate on `f5e5b05a33`.
