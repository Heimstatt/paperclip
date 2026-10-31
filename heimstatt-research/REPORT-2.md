# Report 2: preparing the 16966 contribution

Date: 2026-10-31. Follow-up to `REPORT.md` and `BRIEF-2.md`. Nothing was posted publicly: no PR, no issue
comment, no review, no reaction. Every test suite below ran as an unprivileged user (`runner`), because
Embedded Postgres refuses to run as root. No result below is a skip. In the "test alone" runs (`-t`), the
other 24 tests of the file were filtered out by name; they did not skip because of the environment.

## TL;DR

- **Attribution:** the new branch `research/lease-race-successor-impl-v2` has two commits. The port commit
  is authored by Moody Salem, with a co-author trailer for Bastian. The test commit with our 9 cases is
  Bastian's. Its tree is identical to the old branch, which is unchanged.
- **Fixture:** the stage state is now parsed with `issueExecutionStateSchema`. S1–S3: 15019 3/3, 16966 0/3,
  because S1–S3 call 15019's internal API (see below).
- **Flaky test:** it fails on the **unmodified PR head** too (4/30 and 4/30), so the port did not cause it.
  The cause is in the test: faked `setTimeout` also drives the postgres.js connect timer, which fires
  `CONNECT_TIMEOUT` on a worker pass. A one-line change to the test (disable the driver timers on the test
  client) gave **0 failures in 90 runs**.
- **Review note:** `REVIEW-NOTE.md`, a draft that is not posted.

## 1. Attribution

- The 16966 commits on `pull/16966/head` (`3803bcb898`) are by `Moody Salem <moody.salem@gmail.com>`:
  `9a5cacdc`, `49c36332`, `caecc09e`, `71ef18ad`, `afc85813`, `3803bcb8`, plus two merges of upstream master.
- Cherry-picking onto `master` `f5e5b05a33` stops at the first commit (`9a5cacdc`), with conflicts in
  `heartbeat/queue.ts`, `queue.test.ts`, `run-control.ts` and `run-preparation.ts`. Later commits and the PR's
  own merge resolutions build on each other. As the brief allows, I made **one commit with
  `--author="Moody Salem <moody.salem@gmail.com>"`**. Its tree is the hand-resolved port from `ad7f35e8`.
  `git diff ad7f35e8 c6b555ed` is empty.
- The commit message names the source PR without `#`. It lists the port and conflict work and has the
  trailer `Co-authored-by: Bastian (Heimstatt) <337269694+Bastian-Heimstatt@users.noreply.github.com>`.
  Committer: Bastian (Heimstatt).
- The test commit (our 9 cases) was cherry-picked unchanged and stays a separate commit by Bastian.

| Branch | Commit | Author | Content |
|---|---|---|---|
| `research/lease-race-successor-impl-v2` | `c6b555ed` | Moody Salem | 16966 port onto `f5e5b05a33` |
| | `1011a1a0` | Bastian (Heimstatt) | `lease-race-handoff-wake.test.ts` (9 cases) |
| `research/lease-race-successor-impl` (unchanged) | `ad7f35e8`, `8c412d92` | Bastian | old version |

## 2. Fixture

`heimstatt-13532-stage-wake.test.ts` now builds its `executionState` with
`issueExecutionStateSchema.parse({...})`. It adds `currentStageIndex: 0`, `lastDecisionId: null`,
`lastDecisionOutcome: null`, `completedStageIds: []`, `reviewRequest: null` and `changesRequestedCount: 0`.
This is the only `executionState` the file writes. Because the state is parsed, an incomplete state now fails
when the fixture is built, before any service code runs.

S1–S3 re-run (copied into `server/src/services/`):

| Case | 15019 port | 16966 port (v2) |
|---|---|---|
| S1 | pass | fail |
| S2 | pass | fail |
| S3 | pass | fail |

16966 still fails, and for the same reason as in `REPORT.md`: `strandStage` expects an
`execution_reconciliation_required` receipt (`expected [] to have a length of 1`), and S1–S3 call
`readmitLeaseBlockedHandoffs`, which exists only in 15019. 16966 parks the wake as `deferred_issue_execution`
instead. With a schema-valid state, the behaviour is covered by the portable harness and by
`lease-race-handoff-wake.test.ts`, where 16966 passes 9/9. The corrected fixture removes the difference
between strict and raw-JSON state checks, but S1–S3 still test 15019's model and cannot judge 16966.

## 3. Flaky test

Test: `heartbeat-execution-ownership-wait.test.ts` › "shared ownership-wait worker › observes nested
admission only after outer settlement (rollback=false)". The first run on v2 reproduced the reviewer's
result: 33/34, failing at `idleWorkSnapshot().active` = 1.

### Counts (30 runs each, non-root, run one after another)

| Code | Test alone (`-t`) | Whole file(s) |
|---|---|---|
| v2 branch | 2/30 failed | 6/30 failed (v2 file run also includes `lease-race-handoff-wake.test.ts`) |
| Unmodified `pull/16966/head` | 4/30 failed | 4/30 failed |
| PR head, `waitFor` 5 s → 20 s | 2/30 failed | – |
| PR head, 30 s advanced in 1 s steps | 2/8 failed (run stopped early) | – |
| **PR head + proposed fix** | **0/30** | **0/30** |
| **v2 + proposed fix** | – | **0/30** (34/34 in every run) |

In one v2 whole-file run (run 24), a second test failed too. I did not record which one. No other test
failed in the 90 runs with the fix.

### Cause

**Verdict: the failure comes from the test's timing in 16966 itself, not from the port.**

1. In a failing run, the idle token that stays open is the delivery coordinator's `finishIntent`, taken when
   the transaction inside the test publishes its `intent` signal (`delivery-work-coordinator.ts`). Only a
   worker pass that ends with no pending work releases it.
2. With coordinator logging, the pass that starts on `settled` does not finish. It goes to the error path
   with `Failed query … cause: CONNECT_TIMEOUT 127.0.0.1:<port>` (postgres.js). The pass is then
   re-scheduled `retryMs` (15 s) later in **fake** time. `settle()` waits only 5 s in **real** time
   (`vi.waitFor`), so `active` stays 1.
3. The test fakes `setTimeout` (`vi.useFakeTimers({ toFake: [..., "setTimeout", ...], shouldAdvanceTime: true })`).
   postgres.js arms its connect timer (`connect_timeout`, 30 s by default) through that faked
   `setTimeout`, so `vi.advanceTimersByTimeAsync(30_000)` in `settle()` fires it while the pass is still
   connecting. We think the reconnect happens because the pool's idle timer (`idle_timeout`, 60 s by
   default in `createDb`, also armed through the faked `setTimeout`) closes connections during the 90 s
   advance in `quiet()`. That step follows from the timing; I did not log it directly.
4. This explains why a longer `waitFor` and a stepped advance do not help: the faked driver timer still
   fires.

### Proposed fix (test only, not applied upstream)

`16966-ownership-test-timers.patch`, one line in the PR's test:

```ts
db = createDb(database.connectionString, { idleTimeoutSeconds: 0, connectTimeoutSeconds: 0 });
```

In postgres.js, `0` disables both timers (`timer()` returns a no-op). Product code is not changed. This is a
change to **upstream's test**. I did not commit it to v2 or to any branch. It is only a suggestion in the
review note. An alternative would be to fake only the coordinator's scheduler instead of the global
`setTimeout`, but that would be a larger change to the test.

## 4. Review note

`REVIEW-NOTE.md`: a neutral draft for a later contribution to PR 16966. It credits Moody Salem and covers
the 9 cases, the two hand-resolved conflicts (the task-retry actor check in `queue.ts` and the
`deferBlockedExecution` blocker type with an optional `runId`) and the flaky-test finding with the
proposed fix. Not posted. It uses no `@` mention, so nobody is notified when the file is pushed.

## Not done / limits

- No `pnpm -r typecheck`, `pnpm test:run` or `pnpm build` (same container limits as `REPORT.md`). The v2
  tree is identical to the port that was already typechecked.
- The second failure in v2 file run 24 was not identified.

## Final commit hashes

- `research/lease-race-successor-impl-v2`: `c6b555ed` (port, author Moody Salem) → `1011a1a0` (tests,
  Bastian). Base `f5e5b05a33`.
- `research/lease-race-successor-impl`: unchanged at `8c412d92`.
- This folder: on branch `claude/heimstatt-research-brief-9ac5as`; the commit that adds this report is the
  branch head after push.
