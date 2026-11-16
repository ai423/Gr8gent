import type { ActionRequest, LedgerEvent } from "./types.js";

/** Append-only. There is intentionally no update or delete. */
export interface LedgerStore {
  append(e: Omit<LedgerEvent, "seq" | "at">): Promise<LedgerEvent>;
  forMission(missionId: string): Promise<LedgerEvent[]>;
}

export interface PendingAction {
  id: number;
  missionId: string;
  agentId: string;
  req: ActionRequest;
}

/**
 * Everything the gateway must remember between calls (and between processes).
 * The in-memory version is for tests; Postgres is for real use.
 */
export interface GatewayState {
  /** Money already spent or reserved for in-flight actions. */
  spent(missionId: string): Promise<number>;
  /** Atomically add to spent only if it stays within cap. */
  reserve(missionId: string, amount: number, cap: number): Promise<boolean>;
  release(missionId: string, amount: number): Promise<void>;
  isFrozen(missionId: string): Promise<boolean>;
  setFrozen(missionId: string, frozen: boolean): Promise<void>;
  savePending(p: Omit<PendingAction, "id">): Promise<number>;
  /** Atomically remove and return, so an approval can be used only once. */
  takePending(id: number): Promise<PendingAction | undefined>;
}
