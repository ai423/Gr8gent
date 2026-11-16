import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { ActionGateway, type Agent, type Mission, type ToolSpec } from "@8gent/core";
import { PgChannel, PgGatewayState, PgLedger, PgMissionStore, migrate, type Sql } from "../src/index.js";

const ils = (amount: number) => ({ amount, currency: "ILS" });
const tools = new Map<string, ToolSpec>([
  ["page.update", { name: "page.update", risk: "write" }],
  ["ads.boost", { name: "ads.boost", risk: "spend" }],
]);
const agent: Agent = {
  id: "a1", missionId: "m1", name: "Dana", role: "worker", kind: "managed",
  scopes: ["page.update", "ads.boost"], paused: false,
};
const mission: Mission = {
  id: "m1", autonomy: 2, spendCap: ils(100_00), approvalThreshold: ils(50_00), hopLimit: 3, frozen: false,
};
const req = (tool: string, extra = {}) => ({ agentId: "a1", tool, reason: "test", ...extra });

let sql: Sql;
let calls: string[];
const gateway = (fail = false) =>
  new ActionGateway(new PgLedger(sql), tools, async (r) => {
    if (fail) throw new Error("boom");
    calls.push(r.tool);
    return "ok";
  }, new PgGatewayState(sql));

beforeEach(async () => {
  sql = new PGlite() as unknown as Sql;
  await migrate(sql);
  await new PgMissionStore(sql).create(mission, "w1");
  calls = [];
});

describe("migrations", () => {
  it("are idempotent", async () => {
    expect(await migrate(sql)).toEqual([]);
  });
});

describe("missions", () => {
  it("round-trips", async () => {
    expect(await new PgMissionStore(sql).get("m1")).toEqual(mission);
    expect(await new PgMissionStore(sql).get("nope")).toBeUndefined();
  });
});

describe("ledger", () => {
  it("is append-only: update, delete and truncate are rejected by the database", async () => {
    await new PgLedger(sql).append({ missionId: "m1", agentId: "a1", type: "action_allowed", tool: "t", reason: "r" });
    await expect(sql.query(`update ledger_events set reason = 'x'`)).rejects.toThrow(/append-only/);
    await expect(sql.query(`delete from ledger_events`)).rejects.toThrow(/append-only/);
    await expect(sql.query(`truncate ledger_events`)).rejects.toThrow(/append-only/);
  });

  it("stores and returns cost and tokens in order", async () => {
    const l = new PgLedger(sql);
    await l.append({ missionId: "m1", agentId: "a1", type: "llm_call", tool: "-", reason: "m", tokens: { input: 7, output: 3 } });
    await l.append({ missionId: "m1", agentId: "a1", type: "action_executed", tool: "ads.boost", reason: "r", cost: ils(12) });
    const ev = await l.forMission("m1");
    expect(ev.map((e) => e.seq)).toEqual([1, 2]);
    expect(ev[0]?.tokens).toEqual({ input: 7, output: 3 });
    expect(ev[1]?.cost).toEqual(ils(12));
  });
});

describe("gateway on Postgres", () => {
  it("persists spend and enforces the cap across gateway instances", async () => {
    await gateway().request(mission, agent, req("ads.boost", { cost: ils(40_00) }));
    await gateway().request(mission, agent, req("ads.boost", { cost: ils(40_00) }));
    const third = await gateway().request(mission, agent, req("ads.boost", { cost: ils(40_00) }));
    expect(third.status).toBe("denied");
    expect(await new PgGatewayState(sql).spent("m1")).toBe(80_00);
  });

  it("concurrent spends cannot jointly exceed the cap", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => gateway().request(mission, agent, req("ads.boost", { cost: ils(30_00) }))),
    );
    // Above the 50.00 threshold nothing is auto-approved; use cost under threshold.
    expect(results.every((r) => r.status === "executed" || r.status === "denied")).toBe(true);
    const spent = await new PgGatewayState(sql).spent("m1");
    expect(spent).toBeLessThanOrEqual(100_00);
    expect(results.filter((r) => r.status === "executed")).toHaveLength(3);
  });

  it("a failed action releases its reservation", async () => {
    const r = await gateway(true).request(mission, agent, req("ads.boost", { cost: ils(40_00) }));
    expect(r.status).toBe("failed");
    expect(await new PgGatewayState(sql).spent("m1")).toBe(0);
  });

  it("pending approvals survive a restart and can be used only once", async () => {
    const m1: Mission = { ...mission, autonomy: 1 };
    const pending = await gateway().request(m1, agent, req("page.update"));
    if (pending.status !== "pending_approval") throw new Error("expected pending");
    const afterRestart = gateway(); // a fresh process, same database
    expect((await afterRestart.resolve(m1, agent, pending.approvalId, true)).status).toBe("executed");
    expect((await afterRestart.resolve(m1, agent, pending.approvalId, true)).status).toBe("denied");
    expect(calls).toEqual(["page.update"]);
  });

  it("an approval cannot be used by a different agent or mission", async () => {
    const m1: Mission = { ...mission, autonomy: 1 };
    const pending = await gateway().request(m1, agent, req("page.update"));
    if (pending.status !== "pending_approval") throw new Error("expected pending");
    const other: Agent = { ...agent, id: "a2" };
    expect((await gateway().resolve(m1, other, pending.approvalId, true)).status).toBe("denied");
    expect(calls).toEqual([]);
  });

  it("the kill switch is durable and wins over a stale mission object", async () => {
    await gateway().freeze("m1");
    const r = await gateway().request(mission, agent, req("page.update")); // mission.frozen is still false here
    expect(r.status).toBe("denied");
    await gateway().freeze("m1", false);
    expect((await gateway().request(mission, agent, req("page.update"))).status).toBe("executed");
  });

  it("an unknown mission fails closed: nothing runs (the ledger refuses the orphan event)", async () => {
    const ghost: Mission = { ...mission, id: "ghost" };
    await expect(gateway().request(ghost, agent, req("page.update"))).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("writes the full decision trail to the ledger", async () => {
    await gateway().request(mission, agent, req("page.update"));
    const types = (await new PgLedger(sql).forMission("m1")).map((e) => e.type);
    expect(types).toEqual(["action_allowed", "action_executed"]);
  });
});

describe("channel", () => {
  it("stores messages in order", async () => {
    const c = new PgChannel(sql);
    await c.post({ missionId: "m1", from: "manager", to: "Dana", body: "pull numbers" });
    await c.post({ missionId: "m1", from: "Dana", body: "done" });
    const all = await c.forMission("m1");
    expect(all.map((m) => `${m.from}>${m.to ?? "all"}:${m.body}`)).toEqual(["manager>Dana:pull numbers", "Dana>all:done"]);
  });
});
