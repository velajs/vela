/** Minimal structural bindings; portable declarations do not inject Worker globals. */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface D1Binding {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<Array<{ meta: { changes: number } }>>;
}
export interface SqliteStorage {
  sql: {
    exec(
      sql: string,
      ...bindings: (string | number | null)[]
    ): { toArray(): Record<string, unknown>[] };
  };
  transactionSync<T>(work: () => T): T;
}
