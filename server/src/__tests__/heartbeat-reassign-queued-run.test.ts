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
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.ts";
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

  it("promotes the new assignee's deferred wake when the stale queued-run gate cancels the holder", async () => {
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
    const promoted = await waitFor(async () => {
      const wake = await latestWakeFor(newAgentId, issueId);
      return wake && wake.status !== "deferred_issue_execution" && wake.runId ? wake : null;
    });
    expect(promoted.runId).not.toBeNull();
    const promotedRun = await runStatus(promoted.runId!);
    expect(promotedRun?.agentId).toBe(newAgentId);
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
});
