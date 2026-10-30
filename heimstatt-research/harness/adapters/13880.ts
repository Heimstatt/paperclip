import type { createDb } from "@paperclipai/db";
import type { heartbeatService } from "./heartbeat.js";

type Db = ReturnType<typeof createDb>;
type Heartbeat = ReturnType<typeof heartbeatService>;
type Run = { id: string; companyId: string; agentId: string };

// PR 13880: no release hook; resumeQueuedRuns (scheduler tick) re-admits
// stage handoffs older than 30 seconds.
export const adapter = {
  name: "13880",
  onRelease: async (_db: Db, _hb: Heartbeat, _run: Run, _issueId: string) => {},
  periodic: async (_db: Db, hb: Heartbeat) => { await hb.resumeQueuedRuns(); },
};
