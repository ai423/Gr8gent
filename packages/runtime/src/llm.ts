/** Provider-neutral model interface. Anthropic is the first implementation. */

export interface ToolCall {
  id: string;
  /** The name as the model saw it (provider-safe). */
  name: string;
  input: Record<string, unknown>;
}

export type Turn =
  | { role: "user"; text: string }
  /** `raw` carries provider blocks (e.g. thinking) that must be replayed unchanged. */
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: "tool_results"; results: { id: string; content: string; isError: boolean }[] };

export interface LlmTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmRequest {
  model: string;
  system: string;
  tools: LlmTool[];
  turns: Turn[];
  maxTokens: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface LlmResponse {
  text: string;
  toolCalls: ToolCall[];
  stop: StopReason;
  usage: { input: number; output: number };
  raw?: unknown;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}
