import type { createDb } from "@paperclipai/db";
import type { heartbeatService } from "./heartbeat.js";

type Db = ReturnType<typeof createDb>;
type Heartbeat = ReturnType<typeof heartbeatService>;
type Run = { id: string; companyId: string; agentId: string };

// PR 16966: executor cleanup resumes the task's parked ownership waits; the
// delivery-work worker (startup and a 30-second retry deadline) runs the
// unscoped sweep.
export const adapter = {
  name: "16966",
  onRelease: (_db: Db, hb: Heartbeat, run: Run, issueId: string) =>
    hb.resumeExecutionOwnershipWaits({ companyId: run.companyId, issueId }),
  periodic: async (_db: Db, hb: Heartbeat) => { await hb.resumeExecutionOwnershipWaits(); },
};
