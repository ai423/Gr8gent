import type { GatewayState, LedgerStore, PendingAction } from "./store.js";
import type { LedgerEvent } from "./types.js";

export class InMemoryLedger implements LedgerStore {
  private events: LedgerEvent[] = [];

  async append(e: Omit<LedgerEvent, "seq" | "at">): Promise<LedgerEvent> {
    const event: LedgerEvent = { ...e, seq: this.events.length + 1, at: new Date().toISOString() };
    this.events.push(Object.freeze(event));
    return event;
  }

  async forMission(missionId: string): Promise<LedgerEvent[]> {
    return this.events.filter((e) => e.missionId === missionId);
  }

  /** Synchronous view, handy in tests. */
  all(): readonly LedgerEvent[] {
    return this.events;
  }
}

export class InMemoryGatewayState implements GatewayState {
  private spentBy = new Map<string, number>();
  private frozen = new Set<string>();
  private pending = new Map<number, PendingAction>();
  private next = 1;

  async spent(id: string) { return this.spentBy.get(id) ?? 0; }

  async reserve(id: string, amount: number, cap: number) {
    const cur = this.spentBy.get(id) ?? 0;
    if (cur + amount > cap) return false;
    this.spentBy.set(id, cur + amount);
    return true;
  }

  async release(id: string, amount: number) {
    this.spentBy.set(id, Math.max((this.spentBy.get(id) ?? 0) - amount, 0));
  }

  async isFrozen(id: string) { return this.frozen.has(id); }

  async setFrozen(id: string, on: boolean) {
    if (on) this.frozen.add(id); else this.frozen.delete(id);
  }

  async savePending(p: Omit<PendingAction, "id">) {
    const id = this.next++;
    this.pending.set(id, { ...p, id });
    return id;
  }

  async takePending(id: number) {
    const p = this.pending.get(id);
    this.pending.delete(id);
    return p;
  }
}
