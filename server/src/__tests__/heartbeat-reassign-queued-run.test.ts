import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  costEvents,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { legacyExecutionNeedsReconciliationWithEvidence } from "../services/legacy-execution-recovery.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { truncateTablesWithDeadlockRetry } from "./helpers/truncate-with-deadlock-retry.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentTaskRun = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentTaskRun: mockTrackAgentTaskRun,
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres reassignment queued-run tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("reassignment of an issue with a queued previous-assignee run", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-reassign-queued-run-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    // Promoted runs also write company-scoped rows (skills, events, activity), so
    // clear every dependent table through the company rather than by hand.
    await truncateTablesWithDeadlockRetry(db, `TRUNCATE TABLE "companies" RESTART IDENTITY CASCADE`, {
      attempts: 10,
      delayMs: () => 100,
    });
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appFor(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  /**
   * Seeds one company with three agents. Each agent has a single concurrency
   * slot, occupied by a running run on an unrelated issue, so any run queued
   * for it stays queued instead of starting an adapter.
   */
  async function seedScenario() {
    const companyId = randomUUID();
    const previousAgentId = randomUUID();
    const newAgentId = randomUUID();
    const thirdAgentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const busyConfig = { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } };

    await db.insert(companies).values({
      id: companyId,
      name: "Reassign queued run",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values(
      [
        { id: previousAgentId, name: "Previous" },
        { id: newAgentId, name: "NewAssignee" },
        { id: thirdAgentId, name: "Peer" },
      ].map((agent) => ({
        ...agent,
        companyId,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: busyConfig,
        permissions: {},
      })),
    );
    for (const agentId of [previousAgentId, newAgentId, thirdAgentId]) {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { wakeReason: "test_busy_slot" },
        startedAt: new Date(),
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassigned while the previous assignee is queued",
      status: "todo",
      priority: "medium",
      assigneeAgentId: previousAgentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, previousAgentId, newAgentId, thirdAgentId, issueId };
  }

  async function runStatus(runId: string) {
    return db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        agentId: heartbeatRuns.agentId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function latestWakeFor(agentId: string, issueId: string) {
    const rows = await db
      .select({
        id: agentWakeupRequests.id,
        status: agentWakeupRequests.status,
        runId: agentWakeupRequests.runId,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt);
    const matching = rows.filter((row) => (row.payload as { issueId?: string } | null)?.issueId === issueId);
    return matching.at(-1) ?? null;
  }

  async function waitFor<T>(read: () => Promise<T | null>): Promise<T> {
    let value: T | null = null;
    await vi.waitFor(async () => {
      value = await read();
      expect(value).not.toBeNull();
    }, { timeout: 5_000, interval: 50 });
    return value as T;
  }

  it("cancels the previous assignee's queued issue_assigned run on reassignment and admits the new assignee's wake", async () => {
    const { companyId, previousAgentId, newAgentId, issueId } = await seedScenario();

    // The previous assignee's own assignment wake. Its slot is busy, so the
    // run stays queued and never takes the issue execution lock.
    const queuedRun = await heartbeat.wakeup(previousAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "update" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
      contextSnapshot: { issueId, source: "issue.update", wakeReason: "issue_assigned" },
    });
    expect(queuedRun?.status).toBe("queued");

    const [beforeReassign] = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(beforeReassign?.executionRunId).toBeNull();

    // Reassign through the real route, as the board does.
    const app = appFor({
      type: "board",
      source: "session",
      userId: "local-board",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
      isInstanceAdmin: true,
    });
    await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: newAgentId })
      .expect(200);

    // The previous assignee's queued run is cancelled by the reassignment.
    expect(await runStatus(queuedRun!.id)).toMatchObject({
      status: "cancelled",
      errorCode: "issue_reassigned",
    });

    // The new assignee's wake is admitted, not parked behind the old run.
    const newWake = await waitFor(() => latestWakeFor(newAgentId, issueId));
    expect(newWake.status).not.toBe("deferred_issue_execution");
    expect(newWake.status).not.toBe("cancelled");

    // No recovery run is queued for the previous assignee in its place.
    const previousLiveRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, previousAgentId), eq(heartbeatRuns.status, "queued")));
    expect(previousLiveRuns).toEqual([]);
  });

  it("does not let stopping the active run start a selected queued run before the reassignment commits", async () => {
    // Fixture for the race: the previous assignee runs on the issue in its
    // only slot and also has a queued ownership run on it. Stopping the active
    // run frees the slot, which would claim the queued run under the old
    // assignment if the reassignment did not hold the agent's queue.
    const { companyId, previousAgentId, newAgentId, issueId } = await seedScenario();
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(and(eq(heartbeatRuns.agentId, previousAgentId), eq(heartbeatRuns.status, "running")));
    const activeRunId = randomUUID();
    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        id: activeRunId,
        companyId,
        agentId: previousAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        startedAt: new Date(),
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      },
      {
        id: queuedRunId,
        companyId,
        agentId: previousAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented", wakeCommentId: randomUUID() },
      },
    ]);
    await db.update(issues).set({ executionRunId: activeRunId, status: "in_progress" }).where(eq(issues.id, issueId));

    const app = appFor({
      type: "board",
      source: "session",
      userId: "local-board",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
      isInstanceAdmin: true,
    });
    await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: newAgentId })
      .expect(200);

    expect(await runStatus(activeRunId)).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned" });
    const [queued] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, startedAt: heartbeatRuns.startedAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRunId));
    expect(queued).toEqual({ status: "cancelled", errorCode: "issue_reassigned", startedAt: null });
  });

  it("rolls back the caller's write when a queued run started before it could be cancelled", async () => {
    const { previousAgentId, newAgentId, issueId } = await seedScenario();
    const queuedRun = await heartbeat.wakeup(previousAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "update" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
      contextSnapshot: { issueId, source: "issue.update", wakeReason: "issue_assigned" },
    });
    expect(queuedRun?.status).toBe("queued");
    // Another path claims the run before the reassignment transaction runs.
    await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, queuedRun!.id));

    await expect(db.transaction(async (tx) => {
      await tx.update(issues).set({ assigneeAgentId: newAgentId }).where(eq(issues.id, issueId));
      await heartbeat.cancelQueuedRunsInTx(tx as unknown as typeof db, [queuedRun!.id], {
        reason: "Cancelled by issue reassignment",
        errorCode: "issue_reassigned",
      });
    })).rejects.toMatchObject({ status: 409 });

    const [issue] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, issueId));
    expect(issue?.assigneeAgentId).toBe(previousAgentId);
    expect(await runStatus(queuedRun!.id)).toMatchObject({ status: "running" });
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, queuedRun!.id));
  });

  it("keeps the previous assignee's queued run when the reassigning update is rejected", async () => {
    const { companyId, previousAgentId, newAgentId, issueId } = await seedScenario();
    const queuedRun = await heartbeat.wakeup(previousAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "update" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
      contextSnapshot: { issueId, source: "issue.update", wakeReason: "issue_assigned" },
    });
    expect(queuedRun?.status).toBe("queued");

    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Open blocker",
      status: "todo",
      priority: "medium",
      issueNumber: 2,
    });
    const app = appFor({
      type: "board",
      source: "session",
      userId: "local-board",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
      isInstanceAdmin: true,
    });
    await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ blockedByIssueIds: [blockerIssueId] })
      .expect(200);

    // The reassignment selects the queued run, then the update itself is
    // rejected because the issue still has an open blocker.
    await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: newAgentId, status: "in_progress" })
      .expect(422);

    const [issue] = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(issue?.assigneeAgentId).toBe(previousAgentId);
    expect(await runStatus(queuedRun!.id)).toMatchObject({ status: "queued", errorCode: null });
  });

  it("cancels a stale legacy holder at the queued-run gate and promotes the deferred wake", async () => {
    const { previousAgentId, newAgentId, issueId } = await seedScenario();

    const holderRun = await heartbeat.wakeup(previousAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "update" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
      contextSnapshot: { issueId, source: "issue.update", wakeReason: "issue_assigned" },
    });
    expect(holderRun?.status).toBe("queued");

    // The assignee changes without a cancelling path. The new assignee's wake
    // then finds the old queued run and parks behind it.
    await db.update(issues).set({ assigneeAgentId: newAgentId }).where(eq(issues.id, issueId));
    const deferredRun = await heartbeat.wakeup(newAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "update" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
      contextSnapshot: { issueId, source: "issue.update", wakeReason: "issue_assigned" },
    });
    expect(deferredRun).toBeNull();
    const parked = await waitFor(() => latestWakeFor(newAgentId, issueId));
    expect(parked.status).toBe("deferred_issue_execution");

    const [holderLock] = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(holderLock?.executionRunId).toBe(holderRun!.id);

    // The previous assignee finishes its unrelated run, freeing its slot. The
    // stale queued-run gate then runs when the queue resumes and cancels the
    // old holder, which frees the lock.
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(and(eq(heartbeatRuns.agentId, previousAgentId), eq(heartbeatRuns.status, "running")));
    await heartbeat.resumeQueuedRuns();

    expect(await runStatus(holderRun!.id)).toMatchObject({
      status: "cancelled",
      errorCode: "issue_assignee_changed",
    });
    const [released] = await db
      .select({ executionRunId: issues.executionRunId, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(released).toEqual({ executionRunId: null, status: "todo" });
    // The release queues no recovery for the previous assignee.
    expect(await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, previousAgentId), eq(heartbeatRuns.status, "queued")))).toEqual([]);
    // The shared pre-dispatch verifier proves the holder never started, so the
    // release promotes the new assignee's deferred wake.
    const promoted = await waitFor(async () => {
      const wake = await latestWakeFor(newAgentId, issueId);
      return wake && wake.status !== "deferred_issue_execution" && wake.runId ? wake : null;
    });
    expect((await runStatus(promoted.runId!))?.agentId).toBe(newAgentId);
  });

  it("leaves a native queued run to the queued-run gate without a reconciliation hold", async () => {
    // No current producer leaves a native run queued: native mode is resolved
    // while a claimed run is prepared. This pins the outcome should one exist.
    const { companyId, previousAgentId, newAgentId, issueId } = await seedScenario();
    const nativeRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: nativeRunId,
      companyId,
      agentId: previousAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      runtimeMode: "native",
      runtimeModeResolvedAt: new Date(),
      nativeIssueId: issueId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });

    const app = appFor({
      type: "board",
      source: "session",
      userId: "local-board",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
      isInstanceAdmin: true,
    });
    await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: newAgentId })
      .expect(200);

    // The route does not cancel native runs.
    expect(await runStatus(nativeRunId)).toMatchObject({ status: "queued", errorCode: null });

    // Once the previous assignee has a free slot, the gate cancels the run.
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(and(eq(heartbeatRuns.agentId, previousAgentId), eq(heartbeatRuns.status, "running")));
    await heartbeat.resumeQueuedRuns();

    expect(await runStatus(nativeRunId)).toMatchObject({ status: "cancelled", errorCode: "issue_assignee_changed" });
    const [issue] = await db
      .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(issue).toEqual({ status: "todo", assigneeAgentId: newAgentId });
    expect(await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId))).toEqual([]);
    const promoted = await waitFor(async () => {
      const wake = await latestWakeFor(newAgentId, issueId);
      return wake && wake.status !== "deferred_issue_execution" && wake.runId ? wake : null;
    });
    expect((await runStatus(promoted.runId!))?.agentId).toBe(newAgentId);
  });

  it("leaves the previous assignee's queued interaction_pending wake alone when the issue is reassigned", async () => {
    const { companyId, previousAgentId, newAgentId, issueId } = await seedScenario();
    const app = appFor({
      type: "board",
      source: "session",
      userId: "local-board",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
      isInstanceAdmin: true,
    });

    // The interaction route wakes the interaction's addressee, chosen as the
    // addressee and not as the issue owner. Its slot is busy, so it queues.
    await request(app)
      .post(`/api/issues/${issueId}/interactions`)
      .send({
        kind: "request_confirmation",
        addresseeAgentId: previousAgentId,
        payload: { version: 1, prompt: "Confirm the plan?" },
      })
      .expect(201);
    const interactionRun = await waitFor(async () => {
      const [run] = await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, previousAgentId), eq(heartbeatRuns.status, "queued")));
      return run ?? null;
    });
    expect((interactionRun.contextSnapshot as Record<string, unknown>).wakeReason).toBe("interaction_pending");

    await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: newAgentId })
      .expect(200);

    expect(await runStatus(interactionRun.id)).toMatchObject({ status: "queued", errorCode: null });
  });

  describe("reconciliation after a transactional queued-run cancel", () => {
    async function seedQueuedRun(patch: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
      const { companyId, previousAgentId, issueId } = await seedScenario();
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: previousAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
        ...patch,
      });
      return { companyId, agentId: previousAgentId, issueId, runId };
    }

    async function cancelAndCheckReconciliation(runId: string) {
      const cancelled = await db.transaction((tx) =>
        heartbeat.cancelQueuedRunsInTx(tx as unknown as typeof db, [runId], {
          reason: "Cancelled by issue reassignment",
          errorCode: "issue_reassigned",
        }));
      expect(cancelled).toHaveLength(1);
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(row?.status).toBe("cancelled");
      expect(row?.resultJson).toMatchObject({ stopReason: "issue_reassigned", timeoutSource: "reassignment_queue_cancel" });
      // The shared pre-dispatch verifier decides; this cancel writes no marker of its own.
      expect((row?.resultJson as Record<string, unknown>).executionRecovery).toBeUndefined();
      return legacyExecutionNeedsReconciliationWithEvidence(db, row!);
    }

    it("needs no reconciliation for a queued run with no dispatch evidence", async () => {
      const { runId } = await seedQueuedRun();
      expect(await cancelAndCheckReconciliation(runId)).toBe(false);
    });

    it("needs no reconciliation for a never-run retry whose failure budget is spent", async () => {
      const { companyId, agentId, issueId, runId } = await seedQueuedRun();
      const sourceRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: sourceRunId, companyId, agentId, invocationSource: "assignment", triggerDetail: "system",
        status: "failed", errorCode: "process_lost", startedAt: new Date(), finishedAt: new Date(),
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      });
      await db.update(heartbeatRuns)
        .set({ retryOfRunId: sourceRunId, scheduledRetryAttempt: 2, scheduledRetryReason: "process_lost" })
        .where(eq(heartbeatRuns.id, runId));
      expect(await cancelAndCheckReconciliation(runId)).toBe(false);
    });

    it.each([
      ["startedAt", { startedAt: new Date() }],
      ["runtimeModeResolvedAt", { runtimeModeResolvedAt: new Date() }],
      ["processPid", { processPid: 123 }],
      ["processGroupId", { processGroupId: 123 }],
      ["processStartedAt", { processStartedAt: new Date() }],
      ["nativeIssueId", { nativeIssueId: randomUUID() }],
      ["nativeSessionId", { nativeSessionId: randomUUID() }],
      ["sessionIdAfter", { sessionIdAfter: "provider-session" }],
      ["controllerBootId", { controllerBootId: randomUUID() }],
      ["controllerLeaseExpiresAt", { controllerLeaseExpiresAt: new Date() }],
      ["executionStage", { executionStage: "preparing" }],
      ["an unsafe workspace archive", { resultJson: { workspaceRestoreFailure: "restore_unsafe_archive" } }],
    ] as const)("keeps reconciliation when the run row has %s", async (_label, patch) => {
      const { runId } = await seedQueuedRun(patch as Partial<typeof heartbeatRuns.$inferInsert>);
      expect(await cancelAndCheckReconciliation(runId)).toBe(true);
    });

    // A native finalization coordinator cannot exist without the run's
    // nativeIssueId (native_run_finalizations_run_owner_fk), so that case is
    // covered by the nativeIssueId row case above.

    it("keeps reconciliation when an environment lease is still held", async () => {
      const { companyId, runId } = await seedQueuedRun();
      await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId, provider: "local" });
      expect(await cancelAndCheckReconciliation(runId)).toBe(true);
    });

    it("keeps reconciliation when an execution event was recorded", async () => {
      const { companyId, agentId, runId } = await seedQueuedRun();
      await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 1, eventType: "adapter.invoke" });
      expect(await cancelAndCheckReconciliation(runId)).toBe(true);
    });
  });
});
