/** The only thing the repositories need: satisfied by `pg` (Pool/Client) and PGlite. */
export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
