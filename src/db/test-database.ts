/**
 * TestDatabase
 *
 * A minimal driver contract for database assertions in tests. Vela has no ORM
 * in core, so the harness ships only this interface plus thin assertion
 * wrappers (`module.assertDatabaseHas/Missing/Count`). A consumer — or a future
 * `@velajs/crud` driver — provides the concrete implementation; the harness
 * never couples to a specific database library.
 *
 * @example
 * ```ts
 * class MyTestDb implements TestDatabase {
 *   async truncate() { ... }
 *   async has(table, where) { ... }
 *   async count(table) { ... }
 * }
 * await module.assertDatabaseHas(new MyTestDb(), 'user', { email: 'a@b.com' });
 * ```
 */
export interface TestDatabase {
  /** Remove all rows from every table (reset between tests). */
  truncate(): Promise<void>;
  /** Whether a row matching `where` exists in `table`. */
  has(table: string, where: Record<string, unknown>): Promise<boolean>;
  /** The number of rows in `table`. */
  count(table: string): Promise<number>;
}
