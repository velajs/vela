/** A database seeder. Implement `run()` and tag the class with `@Seeder()`. */
export interface Seeder {
  run(): void | Promise<void>;
}

export interface SeederMetadata {
  /** Display name (defaults to the class name). */
  name?: string;
  /** Ascending run order (default 0). */
  order?: number;
}

export interface RegisteredSeeder {
  name: string;
  order: number;
  /** Exact registration owner; framework-discovered entries always include it. */
  moduleId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- constructor token
  target: new (...args: any[]) => Seeder;
}

export interface SeederResult {
  name: string;
  ok: boolean;
  error?: unknown;
}
