# Portable harness

`heimstatt-portable.test.ts` runs the same nine outcome-level cases against each
candidate. `adapters/<name>.ts` maps the two entry points to each candidate:

- `onRelease`: what the outgoing executor's cleanup calls after it releases the lease.
- `periodic`: what a scheduler tick, worker deadline, or startup calls.

To run it on a branch built from master with a candidate applied:

```sh
cp heimstatt-research/harness/heimstatt-portable.test.ts server/src/services/
cp heimstatt-research/harness/adapters/<name>.ts server/src/services/heimstatt-readmit-adapter.ts
cd server && npx vitest run src/services/heimstatt-portable.test.ts
```

Embedded Postgres refuses to run as root. In a root container, run vitest as an
unprivileged user that owns the checkout (`su tester -c "npx vitest run ..."`).
Otherwise every suite reports `skipped`.

`../ports/<name>-on-master.diff` is each candidate as ported onto upstream master
`f5e5b05a33`. Apply it with `git apply`.
