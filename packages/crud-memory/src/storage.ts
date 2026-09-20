/**
 * Module-level in-memory storage shared by every memory adapter instance, so
 * relations spanning tables resolve against one store.
 *
 * **Edge runtime warning:** on platforms like Cloudflare Workers each isolate
 * gets its own copy of module-level state — data is not shared across isolates
 * and is lost on eviction. Use a persistent adapter for production.
 */
export const storage = new Map<string, Map<string, Record<string, unknown>>>();

/** Returns the per-table Map, creating it lazily. */
export function getStore(tableName: string): Map<string, Record<string, unknown>> {
  let store = storage.get(tableName);
  if (!store) {
    store = new Map();
    storage.set(tableName, store);
  }
  return store;
}

/** Clears all in-memory storage. Useful between tests. */
export function clearMemoryStorage(): void {
  storage.clear();
}
