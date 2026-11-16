import type { LedgerEvent } from "./types.js";

/** Append-only. There is intentionally no update or delete. */
export class Ledger {
  private events: LedgerEvent[] = [];

  append(e: Omit<LedgerEvent, "seq" | "at">): LedgerEvent {
    const event: LedgerEvent = {
      ...e,
      seq: this.events.length + 1,
      at: new Date().toISOString(),
    };
    this.events.push(Object.freeze(event));
    return event;
  }

  all(): readonly LedgerEvent[] {
    return this.events;
  }

  forMission(missionId: string): LedgerEvent[] {
    return this.events.filter((e) => e.missionId === missionId);
  }
}
