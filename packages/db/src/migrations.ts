import type { Sql } from "./sql.js";

/** Each migration is a list of single statements (function bodies contain semicolons). */
export const MIGRATIONS: { id: string; statements: string[] }[] = [
  {
    id: "001_init",
    statements: [
      `create table missions (
         id text primary key,
         workspace_id text not null,
         autonomy int not null check (autonomy between 1 and 3),
         spend_cap_amount bigint not null check (spend_cap_amount >= 0),
         spend_cap_currency text not null,
         approval_threshold_amount bigint,
         hop_limit int not null,
         frozen boolean not null default false,
         spent bigint not null default 0 check (spent >= 0),
         created_at timestamptz not null default now(),
         check (spent <= spend_cap_amount)
       )`,
      `create index missions_workspace on missions (workspace_id)`,
      `create table ledger_events (
         seq bigserial primary key,
         at timestamptz not null default now(),
         mission_id text not null references missions (id),
         agent_id text not null,
         type text not null,
         tool text not null,
         reason text not null,
         detail text,
         cost_amount bigint,
         cost_currency text,
         tokens_in int,
         tokens_out int
       )`,
      `create index ledger_mission_seq on ledger_events (mission_id, seq)`,
      `create function ledger_immutable() returns trigger as $$
         begin raise exception 'ledger is append-only'; end
       $$ language plpgsql`,
      `create trigger ledger_no_change before update or delete on ledger_events
         for each row execute function ledger_immutable()`,
      `create trigger ledger_no_truncate before truncate on ledger_events
         for each statement execute function ledger_immutable()`,
      `create table pending_actions (
         id bigserial primary key,
         mission_id text not null references missions (id),
         agent_id text not null,
         request jsonb not null,
         created_at timestamptz not null default now()
       )`,
      `create table channel_messages (
         seq bigserial primary key,
         at timestamptz not null default now(),
         mission_id text not null references missions (id),
         sender text not null,
         recipient text,
         body text not null
       )`,
      `create index channel_mission_seq on channel_messages (mission_id, seq)`,
    ],
  },
];

export async function migrate(sql: Sql): Promise<string[]> {
  await sql.query(`create table if not exists schema_migrations (id text primary key, at timestamptz not null default now())`);
  const done = new Set((await sql.query<{ id: string }>(`select id from schema_migrations`)).rows.map((r) => r.id));
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await sql.query("begin");
    try {
      for (const st of m.statements) await sql.query(st);
      await sql.query(`insert into schema_migrations (id) values ($1)`, [m.id]);
      await sql.query("commit");
    } catch (e) {
      await sql.query("rollback");
      throw e;
    }
    applied.push(m.id);
  }
  return applied;
}
