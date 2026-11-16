import type { ActionRequest, Agent, Executor, Money, RiskClass, ToolLookup } from "@8gent/core";
import type { LlmTool } from "./llm.js";

export interface ToolDef {
  /** Platform name, e.g. "ads.boost". */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: RiskClass;
  /**
   * Cost is computed by the platform from the arguments, never taken from
   * the model's say-so.
   */
  estimateCost?: (args: Record<string, unknown>) => Money | undefined;
  run: (args: Record<string, unknown>, req: ActionRequest) => Promise<unknown>;
}

/** Provider tool names allow only [a-zA-Z0-9_-]. */
export const toWireName = (name: string) => name.replaceAll(".", "__");

export class Toolbox {
  private defs = new Map<string, ToolDef>();
  private byWire = new Map<string, string>();

  register(def: ToolDef): this {
    this.defs.set(def.name, def);
    this.byWire.set(toWireName(def.name), def.name);
    return this;
  }

  get(name: string): ToolDef | undefined {
    return this.defs.get(name);
  }

  fromWireName(wire: string): string {
    return this.byWire.get(wire) ?? wire;
  }

  /** Live view for the Action Gateway: sees tools registered after it was created. */
  specs: ToolLookup = {
    get: (name) => {
      const d = this.defs.get(name);
      return d ? { name, risk: d.risk } : undefined;
    },
  };

  /** Executor handed to the Action Gateway: the only code that acts on the world. */
  executor: Executor = async (req) => {
    const def = this.defs.get(req.tool);
    if (!def) throw new Error(`no executor for "${req.tool}"`);
    return def.run(req.args ?? {}, req);
  };

  /** Only the tools in the agent's scopes are shown to the model. */
  forAgent(agent: Agent): LlmTool[] {
    return [...this.defs.values()]
      .filter((d) => agent.scopes.includes(d.name))
      .map((d) => ({
        name: toWireName(d.name),
        description: d.description,
        inputSchema: d.inputSchema,
      }));
  }
}
