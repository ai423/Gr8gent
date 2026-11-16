import type {
  GatewayState, LedgerEvent, LedgerEventType, LedgerStore, Mission, PendingAction,
} from "@8gent/core";
import type { ChannelMessage, ChannelSink } from "@8gent/runtime";
import type { Sql } from "./sql.js";

const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));

export class PgMissionStore {
  constructor(private sql: Sql) {}

  async create(m: Mission, workspaceId: string): Promise<void> {
    await this.sql.query(
      `insert into missions (id, workspace_id, autonomy, spend_cap_amount, spend_cap_currency,
         approval_threshold_amount, hop_limit, frozen)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [m.id, workspaceId, m.autonomy, m.spendCap.amount, m.spendCap.currency,
       m.approvalThreshold?.amount ?? null, m.hopLimit, m.frozen],
    );
  }

  async get(id: string): Promise<Mission | undefined> {
    const r = (await this.sql.query<Record<string, unknown>>(`select * from missions where id = $1`, [id])).rows[0];
    if (!r) return undefined;
    const currency = String(r.spend_cap_currency);
    const threshold = num(r.approval_threshold_amount);
    return {
      id: String(r.id),
      autonomy: Number(r.autonomy) as Mission["autonomy"],
      spendCap: { amount: Number(r.spend_cap_amount), currency },
      approvalThreshold: threshold === undefined ? undefined : { amount: threshold, currency },
      hopLimit: Number(r.hop_limit),
      frozen: Boolean(r.frozen),
    };
  }
}

export class PgLedger implements LedgerStore {
  constructor(private sql: Sql) {}

  async append(e: Omit<LedgerEvent, "seq" | "at">): Promise<LedgerEvent> {
    const r = (await this.sql.query<Record<string, unknown>>(
      `insert into ledger_events (mission_id, agent_id, type, tool, reason, detail,
         cost_amount, cost_currency, tokens_in, tokens_out)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning seq, at`,
      [e.missionId, e.agentId, e.type, e.tool, e.reason, e.detail ?? null,
       e.cost?.amount ?? null, e.cost?.currency ?? null,
       e.tokens?.input ?? null, e.tokens?.output ?? null],
    )).rows[0]!;
    return { ...e, seq: Number(r.seq), at: new Date(String(r.at)).toISOString() };
  }

  async forMission(missionId: string): Promise<LedgerEvent[]> {
    const rows = (await this.sql.query<Record<string, unknown>>(
      `select * from ledger_events where mission_id = $1 order by seq`, [missionId],
    )).rows;
    return rows.map((r) => ({
      seq: Number(r.seq),
      at: new Date(String(r.at)).toISOString(),
      missionId: String(r.mission_id),
      agentId: String(r.agent_id),
      type: r.type as LedgerEventType,
      tool: String(r.tool),
      reason: String(r.reason),
      detail: (r.detail as string | null) ?? undefined,
      cost: r.cost_amount === null
        ? undefined
        : { amount: Number(r.cost_amount), currency: String(r.cost_currency) },
      tokens: r.tokens_in === null
        ? undefined
        : { input: Number(r.tokens_in), output: Number(r.tokens_out) },
    }));
  }
}

export class PgGatewayState implements GatewayState {
  constructor(private sql: Sql) {}

  async spent(id: string): Promise<number> {
    const r = (await this.sql.query(`select spent from missions where id = $1`, [id])).rows[0] as
      { spent: unknown } | undefined;
    return r ? Number(r.spent) : 0;
  }

  /** One conditional UPDATE: the database arbitrates concurrent reservations. */
  async reserve(id: string, amount: number, cap: number): Promise<boolean> {
    const r = await this.sql.query(
      `update missions set spent = spent + $2
       where id = $1 and spent + $2 <= least($3::bigint, spend_cap_amount) returning id`,
      [id, amount, cap],
    );
    return r.rows.length > 0;
  }

  async release(id: string, amount: number): Promise<void> {
    await this.sql.query(`update missions set spent = greatest(spent - $2, 0) where id = $1`, [id, amount]);
  }

  async isFrozen(id: string): Promise<boolean> {
    const r = (await this.sql.query(`select frozen from missions where id = $1`, [id])).rows[0] as
      { frozen: boolean } | undefined;
    // An unknown mission is treated as frozen: fail closed.
    return r ? r.frozen : true;
  }

  async setFrozen(id: string, frozen: boolean): Promise<void> {
    await this.sql.query(`update missions set frozen = $2 where id = $1`, [id, frozen]);
  }

  async savePending(p: Omit<PendingAction, "id">): Promise<number> {
    const r = (await this.sql.query(
      `insert into pending_actions (mission_id, agent_id, request) values ($1,$2,$3) returning id`,
      [p.missionId, p.agentId, JSON.stringify(p.req)],
    )).rows[0] as { id: unknown };
    return Number(r.id);
  }

  async takePending(id: number): Promise<PendingAction | undefined> {
    const r = (await this.sql.query(
      `delete from pending_actions where id = $1 returning id, mission_id, agent_id, request`, [id],
    )).rows[0] as { id: unknown; mission_id: string; agent_id: string; request: unknown } | undefined;
    if (!r) return undefined;
    const req = typeof r.request === "string" ? JSON.parse(r.request) : r.request;
    return { id: Number(r.id), missionId: r.mission_id, agentId: r.agent_id, req: req as PendingAction["req"] };
  }
}

export class PgChannel implements ChannelSink {
  constructor(private sql: Sql) {}

  async post(m: Omit<ChannelMessage, "seq" | "at">): Promise<ChannelMessage> {
    const r = (await this.sql.query(
      `insert into channel_messages (mission_id, sender, recipient, body) values ($1,$2,$3,$4) returning seq, at`,
      [m.missionId, m.from, m.to ?? null, m.body],
    )).rows[0] as { seq: unknown; at: unknown };
    return { ...m, seq: Number(r.seq), at: new Date(String(r.at)).toISOString() };
  }

  async forMission(missionId: string): Promise<ChannelMessage[]> {
    const rows = (await this.sql.query<Record<string, unknown>>(
      `select * from channel_messages where mission_id = $1 order by seq`, [missionId],
    )).rows;
    return rows.map((r) => ({
      seq: Number(r.seq),
      at: new Date(String(r.at)).toISOString(),
      missionId: String(r.mission_id),
      from: String(r.sender),
      to: (r.recipient as string | null) ?? undefined,
      body: String(r.body),
    }));
  }
}
