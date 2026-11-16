import { Ledger } from "./ledger.js";
import { evaluate } from "./policy.js";
import type { ActionRequest, Agent, Decision, Mission, Money, ToolSpec } from "./types.js";

export type Executor = (req: ActionRequest) => Promise<unknown>;

/** Looked up on every request, so tools registered later are seen. A Map satisfies this. */
export interface ToolLookup {
  get(name: string): ToolSpec | undefined;
}

export type GatewayResult =
  | { status: "executed"; result: unknown }
  | { status: "pending_approval"; approvalId: number; why: string }
  | { status: "denied"; why: string }
  | { status: "failed"; error: string };

interface Pending { req: ActionRequest; missionId: string }

/**
 * Every agent action goes through here. Agents never hold credentials;
 * the executor (injected) is the only thing that touches the outside world.
 */
export class ActionGateway {
  private spent = new Map<string, number>();
  private pending = new Map<number, Pending>();
  private nextApproval = 1;

  constructor(
    private ledger: Ledger,
    private tools: ToolLookup,
    private execute: Executor,
  ) {}

  spentFor(mission: Mission): Money {
    return { amount: this.spent.get(mission.id) ?? 0, currency: mission.spendCap.currency };
  }

  async request(mission: Mission, agent: Agent, req: ActionRequest): Promise<GatewayResult> {
    const tool = this.tools.get(req.tool);
    const decision: Decision = evaluate({
      mission, agent, tool, request: req, spent: this.spentFor(mission),
    });
    const base = { missionId: mission.id, agentId: agent.id, tool: req.tool, reason: req.reason, cost: req.cost };

    if (decision.outcome === "deny") {
      this.ledger.append({ ...base, type: "action_denied", detail: decision.why });
      return { status: "denied", why: decision.why };
    }
    if (decision.outcome === "needs_approval") {
      const approvalId = this.nextApproval++;
      this.pending.set(approvalId, { req, missionId: mission.id });
      this.ledger.append({ ...base, type: "action_needs_approval", detail: decision.why });
      return { status: "pending_approval", approvalId, why: decision.why };
    }
    this.ledger.append({ ...base, type: "action_allowed" });
    return this.run(mission, base, req);
  }

  /** A human decision. Re-checks policy at execution time (state may have changed). */
  async resolve(
    mission: Mission, agent: Agent, approvalId: number, approve: boolean,
  ): Promise<GatewayResult> {
    const p = this.pending.get(approvalId);
    if (!p) return { status: "denied", why: "unknown approval" };
    this.pending.delete(approvalId);
    const base = { missionId: mission.id, agentId: agent.id, tool: p.req.tool, reason: p.req.reason, cost: p.req.cost };
    if (!approve) {
      this.ledger.append({ ...base, type: "action_rejected" });
      return { status: "denied", why: "rejected by human" };
    }
    this.ledger.append({ ...base, type: "action_approved" });
    // Safety checks that approval must not override.
    const recheck = evaluate({
      mission: { ...mission, autonomy: 3 },
      agent, tool: this.tools.get(p.req.tool), request: p.req, spent: this.spentFor(mission),
    });
    if (recheck.outcome === "deny") {
      this.ledger.append({ ...base, type: "action_denied", detail: recheck.why });
      return { status: "denied", why: recheck.why };
    }
    return this.run(mission, base, p.req);
  }

  private async run(
    mission: Mission,
    base: { missionId: string; agentId: string; tool: string; reason: string; cost?: Money },
    req: ActionRequest,
  ): Promise<GatewayResult> {
    try {
      const result = await this.execute(req);
      if (req.cost) {
        this.spent.set(mission.id, (this.spent.get(mission.id) ?? 0) + req.cost.amount);
      }
      this.ledger.append({ ...base, type: "action_executed" });
      return { status: "executed", result };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.ledger.append({ ...base, type: "action_failed", detail: error });
      return { status: "failed", error };
    }
  }
}
