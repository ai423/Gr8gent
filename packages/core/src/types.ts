export type RiskClass = "read" | "write" | "spend" | "irreversible";
export type AutonomyLevel = 1 | 2 | 3;

export interface Money {
  /** Minor units (cents/agorot) to avoid floating point errors. */
  amount: number;
  currency: string;
}

export interface Agent {
  id: string;
  missionId: string;
  name: string;
  role: "manager" | "worker";
  kind: "managed" | "external";
  /** Tool names this agent may call, e.g. "ads.create_campaign". */
  scopes: string[];
  paused: boolean;
}

export interface ToolSpec {
  name: string;
  risk: RiskClass;
}

export interface Mission {
  id: string;
  autonomy: AutonomyLevel;
  /** Hard cap on money spent by actions classified as "spend". */
  spendCap: Money;
  /** Optional per-action amount above which approval is always required. */
  approvalThreshold?: Money;
  /** Maximum agent-to-agent hops in one conversation. */
  hopLimit: number;
  /** Kill switch: when true, every action is blocked. */
  frozen: boolean;
}

export interface ActionRequest {
  agentId: string;
  tool: string;
  /** Cost this action will incur, if it spends money. */
  cost?: Money;
  /** Current hop count of the conversation that triggered the action. */
  hop?: number;
  /** The agent's stated reason; stored in the ledger. */
  reason: string;
  args?: Record<string, unknown>;
}

export type Decision =
  | { outcome: "allow" }
  | { outcome: "needs_approval"; why: string }
  | { outcome: "deny"; why: string };

export type LedgerEventType =
  | "action_allowed"
  | "action_needs_approval"
  | "action_denied"
  | "action_approved"
  | "action_rejected"
  | "action_executed"
  | "action_failed"
  | "run_started"
  | "run_finished"
  | "llm_call";

export interface LedgerEvent {
  seq: number;
  at: string;
  missionId: string;
  agentId: string;
  type: LedgerEventType;
  tool: string;
  reason: string;
  detail?: string;
  cost?: Money;
  tokens?: { input: number; output: number };
}
