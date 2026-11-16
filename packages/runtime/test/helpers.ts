import {
  ActionGateway, Ledger, type Mission, type Money,
} from "@8gent/core";
import {
  Channel, Toolbox, type AgentConfig, type LlmClient, type LlmRequest,
  type LlmResponse, type RunDeps, type ToolCall,
} from "../src/index.js";

export const ils = (amount: number): Money => ({ amount, currency: "ILS" });

export const mission = (over: Partial<Mission> = {}): Mission => ({
  id: "m1", autonomy: 2, spendCap: ils(100_00), approvalThreshold: ils(50_00),
  hopLimit: 3, frozen: false, ...over,
});

export const agent = (name: string, scopes: string[], over: Partial<AgentConfig> = {}): AgentConfig => ({
  id: name, missionId: "m1", name, role: "worker", kind: "managed",
  scopes, paused: false, model: "test-model", systemPrompt: `You are ${name}.`, ...over,
});

export const call = (name: string, input: Record<string, unknown> = {}, id = `c_${name}`): ToolCall =>
  ({ id, name, input });

export const say = (text: string): LlmResponse =>
  ({ text, toolCalls: [], stop: "end_turn", usage: { input: 10, output: 5 } });

export const use = (toolCalls: ToolCall[], text = ""): LlmResponse =>
  ({ text, toolCalls, stop: "tool_use", usage: { input: 10, output: 5 } });

/** Replays a fixed script of responses and records every request. */
export class ScriptedLlm implements LlmClient {
  requests: LlmRequest[] = [];
  constructor(private script: LlmResponse[] | ((req: LlmRequest) => LlmResponse)) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    if (typeof this.script === "function") return this.script(req);
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    return next;
  }
}

export function setup(toolbox: Toolbox, llm: LlmClient, m: Mission = mission()) {
  const ledger = new Ledger();
  const gateway = new ActionGateway(ledger, toolbox.specs, toolbox.executor);
  const channel = new Channel();
  const deps: RunDeps = { mission: m, gateway, ledger, toolbox, llm, channel };
  return { deps, ledger, gateway, channel };
}

export const noopTool = (name: string, risk: "read" | "write" | "spend" | "irreversible", extra = {}) => ({
  name, description: name, inputSchema: { type: "object", properties: {} },
  risk, run: async () => "done", ...extra,
});
