import type { createDb } from "@paperclipai/db";
import type { heartbeatService } from "./heartbeat.js";

type Db = ReturnType<typeof createDb>;
type Heartbeat = ReturnType<typeof heartbeatService>;
type Run = { id: string; companyId: string; agentId: string };

import { selectReleasedExecutionWake } from "./heartbeat/released-execution-wake.js";

// Fork PR 211: executor cleanup selects the newest skipped wake and enqueues
// it once (heartbeat.ts release block). There is no periodic path.
export const adapter = {
  name: "211",
  onRelease: async (db: Db, hb: Heartbeat, run: Run, issueId: string) => {
    const resume = await selectReleasedExecutionWake(db, { companyId: run.companyId, issueId, releasedRunId: run.id });
    if (resume) await hb.wakeup(resume.agentId, resume.opts);
  },
  periodic: async (_db: Db, _hb: Heartbeat) => {},
};
