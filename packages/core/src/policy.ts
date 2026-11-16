import type {
  ActionRequest, Agent, Decision, Mission, Money, ToolSpec,
} from "./types.js";

export interface PolicyInput {
  mission: Mission;
  agent: Agent;
  tool: ToolSpec | undefined;
  request: ActionRequest;
  /** Total already spent on this mission. */
  spent: Money;
}

/** Pure function: no I/O, same input always gives the same decision. */
export function evaluate({ mission, agent, tool, request, spent }: PolicyInput): Decision {
  if (mission.frozen) return deny("mission is frozen (kill switch)");
  if (agent.paused) return deny("agent is paused");
  if (!tool) return deny(`unknown tool "${request.tool}"`);
  if (!agent.scopes.includes(tool.name)) {
    return deny(`agent has no scope for "${tool.name}"`);
  }
  if ((request.hop ?? 0) > mission.hopLimit) {
    return deny(`hop limit ${mission.hopLimit} exceeded`);
  }

  const cost = request.cost;
  if (cost) {
    if (cost.currency !== mission.spendCap.currency || cost.currency !== spent.currency) {
      return deny("currency mismatch");
    }
    if (cost.amount < 0) return deny("negative cost");
    if (spent.amount + cost.amount > mission.spendCap.amount) {
      return deny("spend cap would be exceeded");
    }
  }
  if (tool.risk === "spend" && !cost) return deny("spend action without cost");

  if (tool.risk === "irreversible") {
    return { outcome: "needs_approval", why: "irreversible actions always need approval" };
  }
  if (mission.autonomy === 1 && tool.risk !== "read") {
    return { outcome: "needs_approval", why: "autonomy level 1 requires approval for non-read actions" };
  }
  const threshold = mission.approvalThreshold;
  if (cost && threshold && cost.amount > threshold.amount) {
    return { outcome: "needs_approval", why: "amount above approval threshold" };
  }
  if (tool.risk === "spend" && mission.autonomy < 3 && !threshold) {
    return { outcome: "needs_approval", why: "no approval threshold set for spend" };
  }
  return { outcome: "allow" };
}

function deny(why: string): Decision {
  return { outcome: "deny", why };
}
