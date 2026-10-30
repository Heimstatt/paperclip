import type { createDb } from "@paperclipai/db";
import type { heartbeatService } from "./heartbeat.js";

type Db = ReturnType<typeof createDb>;
type Heartbeat = ReturnType<typeof heartbeatService>;
type Run = { id: string; companyId: string; agentId: string };

// PR 15019: the cleanup hook re-admits on release; reconcileStrandedAssignedIssues
// (startup and every scheduler tick) runs the 15-minute retry pass.
export const adapter = {
  name: "15019",
  onRelease: (_db: Db, hb: Heartbeat, run: Run, issueId: string) => hb.readmitLeaseBlockedHandoffs(run, issueId),
  periodic: async (_db: Db, hb: Heartbeat) => { await hb.retryLeaseHandoffReadmits(); },
};
