import { InMemoryGatewayState } from "./memory.js";
import { evaluate } from "./policy.js";
import type { GatewayState, LedgerStore } from "./store.js";
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

type Base = { missionId: string; agentId: string; tool: string; reason: string; cost?: Money };

/**
 * Every agent action goes through here. Agents never hold credentials;
 * the executor (injected) is the only thing that touches the outside world.
 */
export class ActionGateway {
  constructor(
    private ledger: LedgerStore,
    private tools: ToolLookup,
    private execute: Executor,
    private state: GatewayState = new InMemoryGatewayState(),
  ) {}

  async spentFor(mission: Mission): Promise<Money> {
    return { amount: await this.state.spent(mission.id), currency: mission.spendCap.currency };
  }

  /** Kill switch: durable, and checked on every action regardless of the caller's copy. */
  freeze(missionId: string, frozen = true) {
    return this.state.setFrozen(missionId, frozen);
  }

  private async fresh(mission: Mission): Promise<Mission> {
    return { ...mission, frozen: mission.frozen || (await this.state.isFrozen(mission.id)) };
  }

  async request(mission: Mission, agent: Agent, req: ActionRequest): Promise<GatewayResult> {
    const m = await this.fresh(mission);
    const decision: Decision = evaluate({
      mission: m, agent, tool: this.tools.get(req.tool), request: req, spent: await this.spentFor(m),
    });
    const base = this.base(m, agent, req);

    if (decision.outcome === "deny") {
      await this.ledger.append({ ...base, type: "action_denied", detail: decision.why });
      return { status: "denied", why: decision.why };
    }
    if (decision.outcome === "needs_approval") {
      const approvalId = await this.state.savePending({ missionId: m.id, agentId: agent.id, req });
      await this.ledger.append({ ...base, type: "action_needs_approval", detail: decision.why });
      return { status: "pending_approval", approvalId, why: decision.why };
    }
    await this.ledger.append({ ...base, type: "action_allowed" });
    return this.run(m, base, req);
  }

  /** A human decision. Re-checks policy at execution time (state may have changed). */
  async resolve(
    mission: Mission, agent: Agent, approvalId: number, approve: boolean,
  ): Promise<GatewayResult> {
    const p = await this.state.takePending(approvalId);
    if (!p || p.missionId !== mission.id || p.agentId !== agent.id) {
      return { status: "denied", why: "unknown approval" };
    }
    const m = await this.fresh(mission);
    const base = this.base(m, agent, p.req);
    if (!approve) {
      await this.ledger.append({ ...base, type: "action_rejected" });
      return { status: "denied", why: "rejected by human" };
    }
    await this.ledger.append({ ...base, type: "action_approved" });
    // Safety checks that approval must not override.
    const recheck = evaluate({
      mission: { ...m, autonomy: 3 },
      agent, tool: this.tools.get(p.req.tool), request: p.req, spent: await this.spentFor(m),
    });
    if (recheck.outcome === "deny") {
      await this.ledger.append({ ...base, type: "action_denied", detail: recheck.why });
      return { status: "denied", why: recheck.why };
    }
    return this.run(m, base, p.req);
  }

  private base(m: Mission, agent: Agent, req: ActionRequest): Base {
    return { missionId: m.id, agentId: agent.id, tool: req.tool, reason: req.reason, cost: req.cost };
  }

  private async run(mission: Mission, base: Base, req: ActionRequest): Promise<GatewayResult> {
    // Reserve first, atomically: concurrent actions cannot jointly exceed the cap.
    const amount = req.cost?.amount ?? 0;
    if (amount > 0 && !(await this.state.reserve(mission.id, amount, mission.spendCap.amount))) {
      const why = "spend cap would be exceeded";
      await this.ledger.append({ ...base, type: "action_denied", detail: why });
      return { status: "denied", why };
    }
    try {
      const result = await this.execute(req);
      await this.ledger.append({ ...base, type: "action_executed" });
      return { status: "executed", result };
    } catch (e) {
      if (amount > 0) await this.state.release(mission.id, amount);
      const error = e instanceof Error ? e.message : String(e);
      await this.ledger.append({ ...base, type: "action_failed", detail: error });
      return { status: "failed", error };
    }
  }
}
