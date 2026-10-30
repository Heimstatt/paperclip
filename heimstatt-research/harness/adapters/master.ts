import type { createDb } from "@paperclipai/db";
import type { heartbeatService } from "./heartbeat.js";

type Db = ReturnType<typeof createDb>;
type Heartbeat = ReturnType<typeof heartbeatService>;
type Run = { id: string; companyId: string; agentId: string };

// Unpatched master: control group. Nothing re-admits a skipped handoff.
export const adapter = {
  name: "master",
  onRelease: async (_db: Db, _hb: Heartbeat, _run: Run, _issueId: string) => {},
  periodic: async (_db: Db, hb: Heartbeat) => { await hb.resumeQueuedRuns(); },
};
