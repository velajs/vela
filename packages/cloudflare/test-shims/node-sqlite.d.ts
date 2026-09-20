declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(location: string);
    exec(sql: string): void;
    prepare(sql: string): {
      all(...bindings: never[]): Record<string, unknown>[];
      run(...bindings: never[]): unknown;
    };
    close(): void;
  }
}
