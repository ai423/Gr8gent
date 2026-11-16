import { describe, expect, it } from "vitest";
import { Toolbox, delegateTool, runAgent, toWireName, DELEGATE_TOOL } from "../src/index.js";
import { agent, call, ils, mission, noopTool, say, ScriptedLlm, setup, use } from "./helpers.js";

describe("runAgent", () => {
  it("runs a tool through the gateway and returns the final text", async () => {
    const tb = new Toolbox().register(noopTool("analytics.read", "read", { run: async () => ({ signups: 12 }) }));
    const llm = new ScriptedLlm([use([call("analytics__read")]), say("12 signups so far")]);
    const { deps, ledger, channel } = setup(tb, llm);
    const a = agent("Dana", ["analytics.read"]);
    const r = await runAgent(deps, { agent: a, task: "report signups" });

    expect(r.status).toBe("completed");
    expect(r.finalText).toBe("12 signups so far");
    expect(r.tokens).toEqual({ input: 20, output: 10 });
    expect(ledger.all().map((e) => e.type)).toEqual([
      "run_started", "llm_call", "action_allowed", "action_executed", "llm_call", "run_finished",
    ]);
    expect(channel.all()[0]?.body).toBe("12 signups so far");
    // tool output is fed back labelled as untrusted data
    const fed = llm.requests[1]?.turns.at(-1);
    expect(fed?.role === "tool_results" && fed.results[0]?.content).toContain("untrusted data");
  });

  it("shows the model only the tools in the agent's scopes, with wire-safe names", async () => {
    const tb = new Toolbox()
      .register(noopTool("analytics.read", "read"))
      .register(noopTool("ads.boost", "spend"));
    const llm = new ScriptedLlm([say("ok")]);
    const { deps } = setup(tb, llm);
    await runAgent(deps, { agent: agent("Dana", ["analytics.read"]), task: "x" });
    expect(llm.requests[0]?.tools.map((t) => t.name)).toEqual(["analytics__read"]);
    expect(toWireName("a.b.c")).toBe("a__b__c");
  });

  it("surfaces pending approvals without executing and lets the run finish", async () => {
    let ran = false;
    const tb = new Toolbox().register(noopTool("page.update", "write", { run: async () => { ran = true; } }));
    const llm = new ScriptedLlm([use([call("page__update")]), say("waiting on approval")]);
    const { deps } = setup(tb, llm, mission({ autonomy: 1 }));
    const r = await runAgent(deps, { agent: agent("Noa", ["page.update"]), task: "update page" });
    expect(ran).toBe(false);
    expect(r.pendingApprovals).toHaveLength(1);
    expect(r.status).toBe("completed");
  });

  it("uses platform-computed cost, ignoring any cost the model claims", async () => {
    const tb = new Toolbox().register(noopTool("ads.boost", "spend", {
      estimateCost: () => ils(60_00),
    }));
    // The model claims a tiny cost; the platform knows it is 60.00.
    const llm = new ScriptedLlm([use([call("ads__boost", { cost: 1 })]), say("done")]);
    const { deps, gateway } = setup(tb, llm, mission({ approvalThreshold: ils(50_00) }));
    const r = await runAgent(deps, { agent: agent("Rom", ["ads.boost"]), task: "boost" });
    expect(r.pendingApprovals).toHaveLength(1); // 60.00 is above the 50.00 threshold
    expect((await gateway.spentFor(deps.mission)).amount).toBe(0);
  });

  it("denies tools outside scope and unknown tools, reporting an error to the model", async () => {
    const tb = new Toolbox().register(noopTool("ads.boost", "spend", { estimateCost: () => ils(1) }));
    const llm = new ScriptedLlm([use([call("ads__boost"), call("made_up")]), say("ok")]);
    const { deps } = setup(tb, llm);
    await runAgent(deps, { agent: agent("Dana", []), task: "x" });
    const fed = llm.requests[1]?.turns.at(-1);
    if (fed?.role !== "tool_results") throw new Error("expected tool results");
    expect(fed.results.every((x) => x.isError && x.content.startsWith("Denied"))).toBe(true);
  });

  it("stops on refusal, truncation, turn limit and token budget", async () => {
    const tb = new Toolbox().register(noopTool("t.read", "read"));
    const a = agent("Dana", ["t.read"]);

    const refusing = setup(tb, new ScriptedLlm([{ ...say(""), stop: "refusal" }]));
    expect((await runAgent(refusing.deps, { agent: a, task: "x" })).status).toBe("refused");

    const truncated = setup(tb, new ScriptedLlm([{ ...say("part"), stop: "max_tokens" }]));
    expect((await runAgent(truncated.deps, { agent: a, task: "x" })).status).toBe("truncated");

    const looping = new ScriptedLlm(() => use([call("t__read")]));
    const limited = setup(tb, looping);
    const lr = await runAgent(limited.deps, { agent: a, task: "x", maxTurns: 3 });
    expect(lr.status).toBe("turn_limit");
    expect(lr.turns).toBe(3);

    const budget = setup(tb, new ScriptedLlm(() => use([call("t__read")])));
    expect((await runAgent(budget.deps, { agent: a, task: "x", tokenBudget: 20 })).status).toBe("token_budget");
  });

  it("does not call the model when the mission is frozen", async () => {
    const llm = new ScriptedLlm([say("never")]);
    const { deps } = setup(new Toolbox(), llm, mission({ frozen: true }));
    const r = await runAgent(deps, { agent: agent("Dana", []), task: "x" });
    expect(r.status).toBe("stopped");
    expect(llm.requests).toHaveLength(0);
  });
});

describe("manager and workers", () => {
  const build = (hopLimit: number) => {
    const tb = new Toolbox().register(noopTool("analytics.read", "read", { run: async () => "data" }));
    const worker = agent("Dana", ["analytics.read"], { role: "worker" });
    const manager = agent("Eyal", [DELEGATE_TOOL], { role: "manager" });
    const llm = new ScriptedLlm((req) => {
      const sys = req.system;
      const last = req.turns.at(-1);
      if (sys.includes("Eyal")) {
        return last?.role === "user"
          ? use([call("team__delegate", { worker: "Dana", task: "pull the numbers" })])
          : say("team report received");
      }
      return last?.role === "user" ? use([call("analytics__read")]) : say("numbers pulled");
    });
    const ctx = setup(tb, llm, mission({ hopLimit }));
    tb.register(delegateTool(ctx.deps, [worker]));
    return { ...ctx, manager, worker };
  };

  it("manager delegates, worker acts through the gateway, report returns", async () => {
    const { deps, ledger, channel, manager } = build(3);
    const r = await runAgent(deps, { agent: manager, task: "get the numbers" });
    expect(r.finalText).toBe("team report received");
    const tools = ledger.all().filter((e) => e.type === "action_executed").map((e) => `${e.agentId}:${e.tool}`);
    expect(tools).toEqual(["Dana:analytics.read", "Eyal:team.delegate"]);
    expect(channel.all().map((m) => `${m.from}>${m.to ?? "all"}`)).toEqual(["manager>Dana", "Dana>all", "Eyal>all"]);
  });

  it("hop limit stops a worker's actions in a too-deep chain", async () => {
    const { deps, ledger, manager } = build(0);
    await runAgent(deps, { agent: manager, task: "get the numbers" });
    const denied = ledger.all().filter((e) => e.type === "action_denied");
    expect(denied.some((e) => e.agentId === "Dana" && e.detail?.includes("hop limit"))).toBe(true);
  });
});
