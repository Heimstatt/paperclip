# Research brief 2: prepare the 16966 contribution (follow-up to REPORT.md)

Owner: Heimstatt (Bastian). Follow-up to `REPORT.md` in this folder. Our reviewer checked it and approved with
conditions. This brief covers those conditions. Nothing here is public upstream work yet.

## Background

- `REPORT.md` recommends PR 16966 (parked ownership wait) as the successor. Its original author is
  **Moody Salem** (`moodysalem`).
- Branch `research/lease-race-successor-impl` has two commits: `ad7f35e8` (port of 16966 onto master
  `f5e5b05a33`, with two conflicts resolved by hand) and `8c412d92` (our 9 outcome cases).
- Reviewer re-run on `8c412d92`, as non-root: outcome cases 9/9. Ownership tests: the first run gave 33/34 and
  an isolated re-run gave 25/25. The failing test was "observes nested admission only after outer settlement
  (rollback=false)", which expected `idleWorkSnapshot().active === 0` and got 1.

## Task

1. **Attribution.** Rebuild the port so that Moody Salem is the git author of the 16966 code. Use his name and
   email exactly as on the PR 16966 commits (`pull/16966/head`). Keep his original commits where they still
   apply on master; otherwise make one commit with `--author` set to him. Add a trailer
   `Co-authored-by: Bastian (Heimstatt) <337269694+Bastian-Heimstatt@users.noreply.github.com>` for the
   port and conflict work. Keep the test commit (our 9 cases) as a separate commit by Bastian. Push the result
   as a new branch `research/lease-race-successor-impl-v2` (keep the old branch as it is).
2. **Fixture.** Fix `heimstatt-13532-stage-wake.test.ts` in this folder: every `executionState` it writes must
   pass `issueExecutionStateSchema`. At least `currentStageIndex`, `lastDecisionId` and `lastDecisionOutcome`
   are missing. Re-run S1–S3 against the 15019 and 16966 ports and update the table.
3. **Flaky test.** Run the failing ownership test at least 30 times as non-root, both on the v2 branch and on
   unmodified `pull/16966/head` (or master plus 16966 as it was). Report the counts. Decide whether the
   failure comes from the port, from 16966 itself, or from the test's timing. If the cause is clear and small,
   propose a fix in the report. Do not change upstream's test without saying so.
4. **Review note.** Write `heimstatt-research/REVIEW-NOTE.md` in neutral English for a later contribution to
   PR 16966: what we tested (the 9 cases), the two conflicts resolved by hand on master (the
   task-retry actor check in `queue.ts`, and the `deferBlockedExecution` blocker type), and the flaky-test
   finding. Credit the PR author. This is a draft only and will not be posted by you.
5. Write `heimstatt-research/REPORT-2.md` with the results of 1–4 and the final commit hashes.

## Limits

- No public action (PR, issue comment, review, reaction) on any repository. Our reviewer gates first, then
  the owner approves.
- No upstream issue or PR numbers with `#` in commit messages (avoids backlinks).
- Skipped tests count as failures. Embedded Postgres refuses to run as root, so run the suites as an
  unprivileged user.
- Push to this branch. If a push is refused, push to your session branch and name it in `REPORT-2.md`.
