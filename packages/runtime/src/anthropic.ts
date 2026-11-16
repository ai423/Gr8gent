import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmRequest, LlmResponse, StopReason, Turn } from "./llm.js";

function toMessages(turns: Turn[]): Anthropic.MessageParam[] {
  return turns.map((t): Anthropic.MessageParam => {
    if (t.role === "user") return { role: "user", content: t.text };
    if (t.role === "assistant") {
      // Replay the exact provider blocks (keeps thinking blocks valid).
      if (t.raw) return { role: "assistant", content: t.raw as Anthropic.ContentBlockParam[] };
      const content: Anthropic.ContentBlockParam[] = [];
      if (t.text) content.push({ type: "text", text: t.text });
      for (const c of t.toolCalls) {
        content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
      }
      return { role: "assistant", content };
    }
    // All results of one assistant turn go in a single user message.
    return {
      role: "user",
      content: t.results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.id,
        content: r.content,
        is_error: r.isError,
      })),
    };
  });
}

function mapStop(s: string | null): StopReason {
  switch (s) {
    case "end_turn": return "end_turn";
    case "tool_use": return "tool_use";
    case "max_tokens": return "max_tokens";
    case "refusal": return "refusal";
    default: return "other";
  }
}

export class AnthropicLlm implements LlmClient {
  /** BYOK: pass the customer's key. Falls back to the environment. */
  constructor(private client: Anthropic = new Anthropic()) {}

  static withKey(apiKey: string): AnthropicLlm {
    return new AnthropicLlm(new Anthropic({ apiKey }));
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    // tool_choice stays "auto": forced tool use is rejected by current models.
    const stream = this.client.messages.stream({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      thinking: { type: "adaptive" },
      ...(req.effort ? { output_config: { effort: req.effort } } : {}),
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })),
      messages: toMessages(req.turns),
    });
    const msg = await stream.finalMessage();

    let text = "";
    const toolCalls = [];
    for (const b of msg.content) {
      if (b.type === "text") text += b.text;
      else if (b.type === "tool_use") {
        toolCalls.push({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
      }
    }
    return {
      text,
      toolCalls,
      stop: mapStop(msg.stop_reason),
      usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens },
      raw: msg.content,
    };
  }
}
