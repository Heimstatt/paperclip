import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, environmentLeases, heartbeatRuns, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "./heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();

// A handoff wake that meets the outgoing run's still-held lease must reach the
// new participant exactly once after the release, whichever path observes it:
// the outgoing executor's cleanup (`onRelease`) or the ownership-wait worker
// at startup or on its retry deadline (`periodic`). These cases assert only
// what an operator sees. Time is simulated by shifting the company's rows into
// the past, never by sleeping.
type Heartbeat = ReturnType<typeof heartbeatService>;
const adapter = {
  onRelease: (_db: unknown, hb: Heartbeat, run: { companyId: string }, issueId: string) =>
    hb.resumeExecutionOwnershipWaits({ companyId: run.companyId, issueId }),
  periodic: async (_db: unknown, hb: Heartbeat) => { await hb.resumeExecutionOwnershipWaits(); },
};

(support.supported ? describe : describe.skip)("handoff wake behind the outgoing run's lease", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("lease-race-handoff-");
    db = createDb(database.connectionString);
  }, 60000);
  afterAll(async () => { await database?.cleanup(); });

  type Stage = "none" | "review" | "review_moved" | "changes_requested";
  async function seed(stage: Stage) {
    const companyId = randomUUID(), outgoingId = randomUUID(), ownerId = randomUUID(), otherId = randomUUID();
    const issueId = randomUUID(), outgoingRunId = randomUUID(), stageId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Handoff", defaultResponsibleUserId: "board",
      issuePrefix: `H${companyId.slice(0, 6)}` });
    const agent = (id: string, name: string) => ({ id, companyId, name, role: "engineer", adapterType: "hermes_local",
      status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(agents).values([agent(outgoingId, "Builder"), agent(ownerId, "Owner"), agent(otherId, "Other")]);
    // The owner is the new assignee. For the return leg the reviewer (outgoing)
    // handed back to the producer (owner).
    // A complete, schema-valid state, as the server writes it.
    const stateBase = { currentStageIndex: 0, currentStageType: "review", completedStageIds: [],
      lastDecisionId: null, reviewRequest: null, changesRequestedCount: stage === "changes_requested" ? 1 : 0 };
    const executionState = stage === "none" ? null : stage === "changes_requested" ? {
      ...stateBase, status: "changes_requested", currentStageId: stageId,
      currentParticipant: { type: "agent", agentId: outgoingId, userId: null },
      returnAssignee: { type: "agent", agentId: ownerId, userId: null },
      lastDecisionOutcome: "changes_requested",
    } : {
      ...stateBase, status: "pending", currentStageId: stage === "review" ? stageId : randomUUID(),
      currentParticipant: { type: "agent", agentId: ownerId, userId: null },
      returnAssignee: { type: "agent", agentId: outgoingId, userId: null },
      lastDecisionOutcome: null,
    };
    await db.insert(issues).values({ id: issueId, companyId, title: "Handoff", assigneeAgentId: ownerId,
      status: stage === "none" ? "todo" : stage === "changes_requested" ? "in_progress" : "in_review",
      ...(executionState ? { executionState } : {}) });
    await db.insert(heartbeatRuns).values({ id: outgoingRunId, companyId, agentId: outgoingId,
      runtimeMode: "legacy", status: "cancelled", errorCode: "issue_reassigned",
      runnerProfileJson: { adapterDispatch: { adapterType: "hermes_local" } },
      contextSnapshot: { issueId }, finishedAt: new Date() });
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: outgoingRunId,
      status: "active", provider: "local" }).returning();
    // Saturate the owner elsewhere so an admitted wake stays `queued`.
    await db.insert(heartbeatRuns).values({ companyId, agentId: ownerId, status: "running" });

    const base = { source: "assignment" as const, triggerDetail: "system" as const,
      requestedByActorType: "agent" as const, requestedByActorId: outgoingId };
    const executionStage = stage === "none" ? null : stage === "changes_requested" ? {
      stageId, stageType: "review", wakeRole: "executor", reviewRequest: null, allowedActions: [],
      currentParticipant: { type: "agent", agentId: outgoingId, userId: null },
      returnAssignee: { type: "agent", agentId: ownerId, userId: null }, lastDecisionOutcome: "changes_requested",
    } : {
      stageId, stageType: "review", wakeRole: "reviewer", reviewRequest: null,
      allowedActions: ["approve", "request_changes"],
      currentParticipant: { type: "agent", agentId: ownerId, userId: null },
      returnAssignee: { type: "agent", agentId: outgoingId, userId: null }, lastDecisionOutcome: null,
    };
    const reason = stage === "none" ? "issue_assigned"
      : stage === "changes_requested" ? "execution_changes_requested" : "execution_review_requested";
    const wake = {
      ...base, reason,
      payload: { issueId, mutation: "update", interruptedRunId: outgoingRunId, ...(executionStage ? { executionStage } : {}) },
      contextSnapshot: { issueId, source: executionStage ? "issue.execution_stage" : "issue.update",
        interruptedRunId: outgoingRunId, ...(executionStage ? { executionStage, wakeReason: reason } : {}) },
    };
    return { companyId, outgoingId, ownerId, otherId, issueId, outgoingRunId, leaseId: lease!.id, wake };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;

  const outgoingRun = (f: Fixture) => ({ id: f.outgoingRunId, companyId: f.companyId, agentId: f.outgoingId });
  const releaseLease = (f: Fixture) => db.update(environmentLeases)
    .set({ status: "released", releasedAt: new Date(), cleanupStatus: "succeeded" })
    .where(eq(environmentLeases.id, f.leaseId));
  const ownerRuns = (f: Fixture) => db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.ownerId)))
    .then(rows => rows.filter(row => (row.contextSnapshot as { issueId?: string } | null)?.issueId === f.issueId));
  // Shift the company's history into the past, as if `minutes` had elapsed.
  async function elapse(f: Fixture, minutes: number) {
    const shift = sql.raw(`interval '${minutes} minutes'`);
    await db.execute(sql`update agent_wakeup_requests set created_at = created_at - ${shift},
      updated_at = updated_at - ${shift}, requested_at = requested_at - ${shift} where company_id = ${f.companyId}`);
    await db.execute(sql`update heartbeat_runs set created_at = created_at - ${shift}, updated_at = updated_at - ${shift},
      finished_at = finished_at - ${shift}, started_at = started_at - ${shift} where company_id = ${f.companyId}`);
    await db.execute(sql`update environment_leases set created_at = created_at - ${shift},
      updated_at = updated_at - ${shift}, released_at = released_at - ${shift} where company_id = ${f.companyId}`);
  }

  // The handoff wake meets the outgoing lease: no run, and some receipt kept.
  async function strand(f: Fixture) {
    await heartbeatService(db).wakeup(f.ownerId, f.wake);
    expect(await ownerRuns(f)).toHaveLength(0);
    const receipts = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, f.ownerId)));
    expect(receipts.map(r => r.status).some(s => s === "skipped" || s === "deferred_issue_execution")).toBe(true);
  }
  async function releaseAndRecover(f: Fixture, hb = heartbeatService(db)) {
    await releaseLease(f);
    await adapter.onRelease(db, hb, outgoingRun(f), f.issueId);
    await elapse(f, 1);
    await adapter.periodic(db, hb);
  }

  it("P1: plain reassignment handoff → one run after lease release", async () => {
    const f = await seed("none");
    await strand(f);
    await releaseAndRecover(f);
    expect(await ownerRuns(f)).toHaveLength(1);
  });

  it("S1: review-stage handoff, state still on that stage → one run, and only one", async () => {
    const f = await seed("review");
    await strand(f);
    await releaseAndRecover(f);
    expect(await ownerRuns(f)).toHaveLength(1);
    await adapter.onRelease(db, heartbeatService(db), outgoingRun(f), f.issueId);
    await elapse(f, 1);
    await adapter.periodic(db, heartbeatService(db));
    expect(await ownerRuns(f)).toHaveLength(1);
  });

  it("S2: review-stage handoff, issue already on another stage → nothing", async () => {
    const f = await seed("review_moved");
    await strand(f);
    await releaseAndRecover(f);
    expect(await ownerRuns(f)).toHaveLength(0);
  });

  it("S3: lease still held → nothing yet, then one run once it is released", async () => {
    const f = await seed("review");
    await strand(f);
    await adapter.onRelease(db, heartbeatService(db), outgoingRun(f), f.issueId);
    await elapse(f, 1);
    await adapter.periodic(db, heartbeatService(db));
    expect(await ownerRuns(f)).toHaveLength(0);
    await releaseAndRecover(f);
    expect(await ownerRuns(f)).toHaveLength(1);
  });

  it("R1: return leg — changes_requested hand-back to the producer → one run", async () => {
    const f = await seed("changes_requested");
    await strand(f);
    await releaseAndRecover(f);
    expect(await ownerRuns(f)).toHaveLength(1);
  });

  it("R2: admission fails on release → a later pass still delivers exactly one run", async () => {
    const f = await seed("review");
    await strand(f);
    const fn = `fail_handoff_admission_${f.ownerId.replace(/-/g, "")}`;
    await db.execute(sql.raw(`create function ${fn}() returns trigger language plpgsql as $$
      begin
        if new.agent_id = '${f.ownerId}' and new.context_snapshot->>'issueId' = '${f.issueId}' then
          raise exception 'injected admission failure';
        end if;
        return new;
      end $$`));
    await db.execute(sql.raw(`create trigger ${fn} before insert on heartbeat_runs for each row execute function ${fn}()`));
    try {
      await releaseLease(f);
      await adapter.onRelease(db, heartbeatService(db), outgoingRun(f), f.issueId).catch(() => undefined);
      expect(await ownerRuns(f)).toHaveLength(0);
    } finally {
      await db.execute(sql.raw(`drop trigger ${fn} on heartbeat_runs`));
      await db.execute(sql.raw(`drop function ${fn}()`));
    }
    await elapse(f, 1);
    await adapter.periodic(db, heartbeatService(db));
    expect(await ownerRuns(f)).toHaveLength(1);
  });

  it("R3: release lands while scheduling is suppressed → one run once suppression lifts", async () => {
    const f = await seed("review");
    await strand(f);
    const runtimeEnv: Record<string, string> = { PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "true" };
    const hb = heartbeatService(db, { runtimeEnv });
    await releaseLease(f);
    await adapter.onRelease(db, hb, outgoingRun(f), f.issueId);
    expect(await ownerRuns(f)).toHaveLength(0);
    runtimeEnv.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "false";
    await elapse(f, 1);
    await adapter.periodic(db, heartbeatService(db));
    expect(await ownerRuns(f)).toHaveLength(1);
  });

  it("L1: release hook missed (crash/outage), first periodic pass 30 minutes later → one run", async () => {
    const f = await seed("review");
    await strand(f);
    await releaseLease(f);
    await elapse(f, 30);
    await adapter.periodic(db, heartbeatService(db));
    expect(await ownerRuns(f)).toHaveLength(1);
  });

  it("L2: same after a 24-hour outage → one run", async () => {
    const f = await seed("review");
    await strand(f);
    await releaseLease(f);
    await elapse(f, 24 * 60);
    await adapter.periodic(db, heartbeatService(db));
    expect(await ownerRuns(f)).toHaveLength(1);
  });
});
