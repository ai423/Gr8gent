import { describe, expect, it } from "vitest";
import { ActionGateway, InMemoryLedger, type Agent, type Mission, type ToolSpec } from "../src/index.js";

const ils = (amount: number) => ({ amount, currency: "ILS" });
const tools = new Map<string, ToolSpec>([
  ["analytics.read", { name: "analytics.read", risk: "read" }],
  ["page.update", { name: "page.update", risk: "write" }],
  ["ads.boost", { name: "ads.boost", risk: "spend" }],
  ["email.blast", { name: "email.blast", risk: "irreversible" }],
]);
const agent: Agent = {
  id: "a1", missionId: "m1", name: "Dana", role: "worker", kind: "managed",
  scopes: ["analytics.read", "page.update", "ads.boost", "email.blast"], paused: false,
};
const mission = (over: Partial<Mission> = {}): Mission => ({
  id: "m1", autonomy: 2, spendCap: ils(100_00), approvalThreshold: ils(50_00),
  hopLimit: 5, frozen: false, ...over,
});
const setup = () => {
  const ledger = new InMemoryLedger();
  const calls: string[] = [];
  const gw = new ActionGateway(ledger, tools, async (r) => { calls.push(r.tool); return "ok"; });
  return { ledger, calls, gw };
};
const req = (tool: string, extra = {}) => ({ agentId: "a1", tool, reason: "test", ...extra });

describe("ActionGateway", () => {
  it("allows read at level 1 and executes", async () => {
    const { gw, calls } = setup();
    const r = await gw.request(mission({ autonomy: 1 }), agent, req("analytics.read"));
    expect(r.status).toBe("executed");
    expect(calls).toEqual(["analytics.read"]);
  });

  it("level 1 requires approval for writes; approval executes", async () => {
    const { gw, calls } = setup();
    const m = mission({ autonomy: 1 });
    const r = await gw.request(m, agent, req("page.update"));
    expect(r.status).toBe("pending_approval");
    expect(calls).toEqual([]);
    if (r.status !== "pending_approval") return;
    const done = await gw.resolve(m, agent, r.approvalId, true);
    expect(done.status).toBe("executed");
  });

  it("rejection does not execute", async () => {
    const { gw, calls } = setup();
    const m = mission({ autonomy: 1 });
    const r = await gw.request(m, agent, req("page.update"));
    if (r.status !== "pending_approval") throw new Error("expected pending");
    expect((await gw.resolve(m, agent, r.approvalId, false)).status).toBe("denied");
    expect(calls).toEqual([]);
  });

  it("spend within threshold is allowed and counted against the cap", async () => {
    const { gw } = setup();
    const m = mission();
    expect((await gw.request(m, agent, req("ads.boost", { cost: ils(40_00) }))).status).toBe("executed");
    expect((await gw.spentFor(m)).amount).toBe(40_00);
  });

  it("spend above threshold needs approval", async () => {
    const { gw } = setup();
    const r = await gw.request(mission(), agent, req("ads.boost", { cost: ils(60_00) }));
    expect(r.status).toBe("pending_approval");
  });

  it("cap cannot be exceeded, even with approval", async () => {
    const { gw } = setup();
    const m = mission();
    await gw.request(m, agent, req("ads.boost", { cost: ils(40_00) }));
    await gw.request(m, agent, req("ads.boost", { cost: ils(40_00) }));
    const r = await gw.request(m, agent, req("ads.boost", { cost: ils(40_00) }));
    expect(r.status).toBe("denied");
    expect((await gw.spentFor(m)).amount).toBe(80_00);
  });

  it("irreversible always needs approval, even at level 3", async () => {
    const { gw } = setup();
    const r = await gw.request(mission({ autonomy: 3 }), agent, req("email.blast"));
    expect(r.status).toBe("pending_approval");
  });

  it("kill switch, pause, missing scope, unknown tool, hop limit all deny", async () => {
    const { gw } = setup();
    expect((await gw.request(mission({ frozen: true }), agent, req("analytics.read"))).status).toBe("denied");
    expect((await gw.request(mission(), { ...agent, paused: true }, req("analytics.read"))).status).toBe("denied");
    expect((await gw.request(mission(), { ...agent, scopes: [] }, req("analytics.read"))).status).toBe("denied");
    expect((await gw.request(mission(), agent, req("nope"))).status).toBe("denied");
    expect((await gw.request(mission(), agent, req("analytics.read", { hop: 6 }))).status).toBe("denied");
  });

  it("freezing between request and approval blocks execution", async () => {
    const { gw, calls } = setup();
    const r = await gw.request(mission({ autonomy: 1 }), agent, req("page.update"));
    if (r.status !== "pending_approval") throw new Error("expected pending");
    const done = await gw.resolve(mission({ autonomy: 1, frozen: true }), agent, r.approvalId, true);
    expect(done.status).toBe("denied");
    expect(calls).toEqual([]);
  });

  it("failed executions are logged and do not count as spend", async () => {
    const ledger = new InMemoryLedger();
    const gw = new ActionGateway(ledger, tools, async () => { throw new Error("boom"); });
    const m = mission();
    const r = await gw.request(m, agent, req("ads.boost", { cost: ils(10_00) }));
    expect(r.status).toBe("failed");
    expect((await gw.spentFor(m)).amount).toBe(0);
    expect(ledger.all().at(-1)?.type).toBe("action_failed");
  });

  it("every decision lands in the ledger in order", async () => {
    const { gw, ledger } = setup();
    await gw.request(mission(), agent, req("analytics.read"));
    await gw.request(mission(), agent, req("nope"));
    expect(ledger.all().map((e) => e.type)).toEqual(["action_allowed", "action_executed", "action_denied"]);
    expect(ledger.all().map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});
