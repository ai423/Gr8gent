export interface ChannelMessage {
  seq: number;
  at: string;
  missionId: string;
  from: string;
  to?: string;
  body: string;
}

/** The shared conversation of a mission, visible to the user. */
export class Channel {
  private messages: ChannelMessage[] = [];
  private listeners: ((m: ChannelMessage) => void)[] = [];

  post(m: Omit<ChannelMessage, "seq" | "at">): ChannelMessage {
    const msg = { ...m, seq: this.messages.length + 1, at: new Date().toISOString() };
    this.messages.push(msg);
    for (const l of this.listeners) l(msg);
    return msg;
  }

  all(): readonly ChannelMessage[] {
    return this.messages;
  }

  subscribe(fn: (m: ChannelMessage) => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter((l) => l !== fn); };
  }
}
