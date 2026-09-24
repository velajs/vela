declare module 'node:sqlite' {
  /** A value SQLite binds to a statement parameter (Node's `SQLInputValue`). */
  export type SQLInputValue = null | number | bigint | string;

  export class DatabaseSync {
    constructor(location: string);
    exec(sql: string): void;
    prepare(sql: string): {
      all(...bindings: SQLInputValue[]): Record<string, unknown>[];
      run(...bindings: SQLInputValue[]): unknown;
    };
    close(): void;
  }
}
