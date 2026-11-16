import type { AgentConfig, RunDeps, RunResult } from "./runner.js";
import { runAgent } from "./runner.js";
import type { ToolDef } from "./toolbox.js";

export const DELEGATE_TOOL = "team.delegate";

/**
 * The manager's only way to use workers. It goes through the Action Gateway
 * like any other tool, so the hop limit, pause and kill switch all apply.
 */
export function delegateTool(deps: RunDeps, workers: AgentConfig[]): ToolDef {
  const names = workers.map((w) => w.name);
  return {
    name: DELEGATE_TOOL,
    description:
      `Assign a task to a team member and get their report. Members: ${names.join(", ")}. ` +
      "Give a self-contained task with the context they need.",
    inputSchema: {
      type: "object",
      properties: {
        worker: { type: "string", enum: names },
        task: { type: "string" },
      },
      required: ["worker", "task"],
    },
    risk: "read",
    run: async (args, req) => {
      const worker = workers.find((w) => w.name === args.worker);
      if (!worker || typeof args.task !== "string") throw new Error("unknown worker or missing task");
      deps.channel.post({
        missionId: deps.mission.id, from: "manager", to: worker.name, body: args.task,
      });
      const r = await runAgent(deps, { agent: worker, task: args.task, hop: (req.hop ?? 0) + 1 });
      return summarize(r);
    },
  };
}

function summarize(r: RunResult) {
  return {
    status: r.status,
    report: r.finalText,
    pendingApprovals: r.pendingApprovals,
  };
}
