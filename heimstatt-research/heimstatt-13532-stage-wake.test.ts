import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, environmentLeases, heartbeatRuns, issueRecoveryActions, issues,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";
import { issueExecutionStateSchema } from "@paperclipai/shared";
import { getExecutionBlocker } from "./execution-blocker.js";
import { heartbeatService } from "./heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();

// Agent A hands its issue to agent B from inside its own run. The reassignment
// cancels A's run, and B's assignment wake arrives while A's environment lease
// is still being released. Admission stores that wake as a terminal `skipped`
// execution wait. Once A's cleanup has released the lease, B must get exactly
// one run, and nothing else may start.
(support.supported ? describe : describe.skip)("heimstatt repro: review-stage handoff blocked by the outgoing lease", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("heimstatt-13532-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => { await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), outgoingId = randomUUID(), ownerId = randomUUID(), otherId = randomUUID();
    const issueId = randomUUID(), outgoingRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Handoff", defaultResponsibleUserId: "board",
      issuePrefix: `L${companyId.slice(0, 6)}` });
    const agent = (id: string, name: string) => ({ id, companyId, name, role: "engineer", adapterType: "hermes_local",
      status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(agents).values([agent(outgoingId, "Builder"), agent(ownerId, "Reviewer"), agent(otherId, "Other")]);
    // The PATCH has already handed the issue to the reviewer.
    await db.insert(issues).values({ id: issueId, companyId, title: "Hand-back for review", status: "todo",
      assigneeAgentId: ownerId });
    // The builder's run was stopped by the reassignment; no process remains.
    await db.insert(heartbeatRuns).values({ id: outgoingRunId, companyId, agentId: outgoingId,
      runtimeMode: "legacy", status: "cancelled", errorCode: "issue_reassigned",
      runnerProfileJson: { adapterDispatch: { adapterType: "hermes_local" } },
      contextSnapshot: { issueId }, finishedAt: new Date() });
    // Its lease is released a few milliseconds later, by the executor's cleanup.
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: outgoingRunId,
      status: "active", provider: "local" }).returning();
    // Saturate the reviewer elsewhere so an admitted wake stays `queued`.
    await db.insert(heartbeatRuns).values({ companyId, agentId: ownerId, status: "running" });
    return { companyId, outgoingId, ownerId, otherId, issueId, outgoingRunId, leaseId: lease!.id };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;

  // The wake the issue update route sends the new assignee (no comment).
  const handoffWake = (f: Fixture) => ({
    source: "assignment" as const, triggerDetail: "system" as const, reason: "issue_assigned",
    payload: { issueId: f.issueId, mutation: "update", interruptedRunId: f.outgoingRunId },
    requestedByActorType: "agent" as const, requestedByActorId: f.outgoingId,
    contextSnapshot: { issueId: f.issueId, source: "issue.update", interruptedRunId: f.outgoingRunId },
  });

  const outgoingRun = (f: Fixture) => ({ id: f.outgoingRunId, companyId: f.companyId, agentId: f.outgoingId });
  const releaseLease = (f: Fixture) => db.update(environmentLeases)
    .set({ status: "released", releasedAt: new Date(), cleanupStatus: "succeeded" })
    .where(eq(environmentLeases.id, f.leaseId));
  const issueRuns = (f: Fixture, agentId = f.ownerId) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, agentId)))
    .then(rows => rows.filter(row => (row.contextSnapshot as { issueId?: string } | null)?.issueId === f.issueId));
  const receiptFor = async (f: Fixture) => {
    const rows = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, f.ownerId),
      eq(agentWakeupRequests.reason, "execution_reconciliation_required")));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  };

  async function strand(f: Fixture) {
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({
      cause: "execution_owner_active", runId: f.outgoingRunId,
    });
    await heartbeatService(db).wakeup(f.ownerId, handoffWake(f));
    const receipt = await receiptFor(f);
    expect(receipt).toMatchObject({ status: "skipped", runId: null });
    expect(await issueRuns(f)).toHaveLength(0);
    return receipt;
  }
  // Heimstatt repro for #13532: on our instance 37 of 38 skipped receipts are
  // review-stage handoffs (payload.executionStage, stageType review, wakeRole
  // reviewer) whose interruptedRunId is the builder's run cancelled with
  // issue_reassigned. The PR text says its own data had no stage receipts.
  async function seedStage(opts: { stateMatches: boolean }) {
    const f = await seed();
    const stageId = randomUUID();
    // Every executionState written here must be one the server could write:
    // parse it with the shared schema so the fixture cannot drift again.
    const executionState = issueExecutionStateSchema.parse({
      status: "pending",
      currentStageId: opts.stateMatches ? stageId : randomUUID(),
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: f.ownerId, userId: null },
      returnAssignee: { type: "agent", agentId: f.outgoingId, userId: null },
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      changesRequestedCount: 0,
    });
    await db.update(issues).set({ status: "in_review", executionState }).where(eq(issues.id, f.issueId));
    const executionStage = {
      stageId, wakeRole: "reviewer", stageType: "review", reviewRequest: null,
      allowedActions: ["approve", "request_changes"],
      returnAssignee: { type: "agent", userId: null, agentId: f.outgoingId },
      currentParticipant: { type: "agent", userId: null, agentId: f.ownerId },
      lastDecisionOutcome: null,
    };
    return { ...f, stageId, executionStage };
  }
  const stageWake = (f: Awaited<ReturnType<typeof seedStage>>) => {
    const w = handoffWake(f);
    return {
      ...w, reason: "execution_review_requested",
      payload: { ...w.payload, executionStage: f.executionStage },
      contextSnapshot: { ...w.contextSnapshot, executionStage: f.executionStage },
    };
  };
  async function strandStage(f: Awaited<ReturnType<typeof seedStage>>) {
    await heartbeatService(db).wakeup(f.ownerId, stageWake(f));
    const receipt = await receiptFor(f);
    console.log("HEIMSTATT_RECEIPT " + JSON.stringify({ status: receipt.status,
      keys: Object.keys(receipt.payload as object).sort(),
      hasStage: (receipt.payload as any).executionStage?.stageId === f.stageId }));
    return receipt;
  }

  it("S1: review-stage handoff in in_review, state still on that stage → one run after lease release", async () => {
    const f = await seedStage({ stateMatches: true });
    await strandStage(f);
    expect(await issueRuns(f)).toHaveLength(0);
    await releaseLease(f);
    await heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
    const runs = await issueRuns(f);
    console.log("HEIMSTATT_OBSERVATION " + JSON.stringify({ case: "S1", runs: runs.length, status: runs[0]?.status, wakeReason: (runs[0]?.contextSnapshot as any)?.wakeReason }));
    expect(runs).toHaveLength(1);
  });

  it("S2: same, but the issue already moved to another stage → nothing", async () => {
    const f = await seedStage({ stateMatches: false });
    await strandStage(f);
    await releaseLease(f);
    await heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
    const runs = await issueRuns(f);
    console.log("HEIMSTATT_OBSERVATION " + JSON.stringify({ case: "S2", runs: runs.length }));
    expect(runs).toHaveLength(0);
  });

  it("S3: lease still held → nothing yet", async () => {
    const f = await seedStage({ stateMatches: true });
    await strandStage(f);
    await heartbeatService(db).readmitLeaseBlockedHandoffs(outgoingRun(f), f.issueId);
    const runs = await issueRuns(f);
    console.log("HEIMSTATT_OBSERVATION " + JSON.stringify({ case: "S3", runs: runs.length }));
    expect(runs).toHaveLength(0);
  });
});
