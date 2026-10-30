# Research brief: lease-race handoff wake (successor fix)

Owner: Heimstatt (Bastian). Work branch for a cloud session. Nothing here is public upstream work yet.

## Problem

After a reassignment or stage handoff, the wake for the new participant is recorded as `skipped` while the
outgoing run's environment lease is still releasing, and it is never retried. The handoff stays stuck. We hit
this in production (38 skipped receipts in 27.09.–02.10.) and run a local patch for it.

Upstream (paperclipai/paperclip), for reading only:
- Issue 13532 (original report, several operator confirmations), issue 18315 (fresh report on 2026.1023.0).
- PR 15019 (re-admit a skipped handoff wake; conflicts with current master, ~900 commits behind).
- PR 13880, PR 16966 (related, stale/conflicted).
- Fork PR phenix3443/paperclip#211 (wakes directly from the lease release event; operator reports 28 skipped
  assignment wakes in two days).

## Our regression material (this folder)

- `heimstatt-13532-stage-wake.test.ts`: our three review-stage cases S1–S3 (real payload shapes).
- `15019-changes-requested-regression.patch`: return leg in `changes_requested` on the same stage.
- On PR 15019 head `84defd0b2` (12.10.) all passed: `lease-handoff-readmit.test.ts` 31/31, S1–S3 3/3.
- Open question from reading 15019: its retry pass only selects receipts from the last 15 minutes; a longer
  outage or suppression could drop the receipt.

## Task

1. Fetch current upstream `master`. For 15019, 211 and (if cheap) 13880/16966: does the approach still apply
   on master, what conflicts, which code paths changed?
2. Run our cases plus each fix's own tests against each candidate rebased on master (Embedded Postgres,
   only the relevant test files; no full typecheck needed).
3. Write `heimstatt-research/REPORT.md`: per candidate, result table (pass/fail/skipped per case), what it
   covers (handoff leg, return leg, long outage), risks. Recommendation: which approach a successor should take.
4. If one approach is clearly best: prepare a clean branch `research/lease-race-successor-impl` rebased on
   master with tests. Do not open any PR, do not comment anywhere on GitHub.

## Limits

- No public action (PR, issue comment, review) on any repository. Our reviewer gates first, then the owner approves.
- No upstream issue/PR numbers with `#` in commit messages or fork PRs (avoids backlinks).
- Skipped tests count as failures in the report.
