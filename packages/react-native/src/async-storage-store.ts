import type { MutationStore, PersistedMutation } from '@velajs/client';
import type { AsyncStorageLike } from './types';

/** Default key the whole persisted-mutation array serializes under. */
export const DEFAULT_MUTATION_STORE_KEY = 'velajs.mutations';

/**
 * A durable {@link MutationStore} backed by a single {@link AsyncStorageLike}
 * key holding the whole FIFO mutation array as one JSON document.
 *
 * Two properties matter for correctness against the client's offline queue:
 *
 *  - **Write serialization.** The queue mirrors each append/remove WITHOUT
 *    awaiting it (a fire-and-forget `Promise.resolve().then(...)`), so several
 *    ops can be in flight at once. A read-modify-write against a single key
 *    would lose writes under that interleaving, so every op runs through one
 *    promise chain (`tail = tail.then(op)`) and mutates an in-memory mirror
 *    seeded once from storage — the mirror is the source of truth between
 *    writes, storage is just its durable shadow.
 *  - **Corruption tolerance.** `load()` never throws: a key holding invalid
 *    JSON, or valid JSON that is not an array (a partial write, a foreign
 *    writer, a downgraded schema), decodes to `[]` rather than rejecting the
 *    hydrate.
 */
export function createAsyncStorageMutationStore(config: {
  storage: AsyncStorageLike;
  key?: string;
}): MutationStore {
  const { storage } = config;
  const key = config.key ?? DEFAULT_MUTATION_STORE_KEY;

  // `undefined` until the first op seeds it from storage; thereafter it is the
  // authoritative FIFO list and storage is written from it.
  let mirror: PersistedMutation[] | undefined;
  let tail: Promise<unknown> = Promise.resolve();

  const seed = async (): Promise<PersistedMutation[]> => {
    if (mirror === undefined) mirror = decodeRecords(await storage.getItem(key));
    return mirror;
  };

  /** Serialize `op` after every previously queued op; never let a rejection break the chain. */
  const chain = <T>(op: () => Promise<T>): Promise<T> => {
    const run = tail.then(op);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    append(record) {
      return chain(async () => {
        const records = await seed();
        records.push(clone(record));
        await storage.setItem(key, JSON.stringify(records));
      });
    },
    load() {
      return chain(async () => {
        const records = await seed();
        return records.map(clone);
      });
    },
    remove(id) {
      return chain(async () => {
        const records = await seed();
        mirror = records.filter((record) => record.id !== id);
        await storage.setItem(key, JSON.stringify(mirror));
      });
    },
    clear() {
      return chain(async () => {
        mirror = [];
        await storage.removeItem(key);
      });
    },
  };
}

/** Decode a stored JSON array of records; anything non-array (or unparseable) → `[]`. */
function decodeRecords(raw: string | null): PersistedMutation[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? (parsed as PersistedMutation[]) : [];
}

/** Deep-copy a record so a caller's later mutation can never corrupt the mirror. */
const clone = (record: PersistedMutation): PersistedMutation =>
  (globalThis as { structuredClone?: <T>(value: T) => T }).structuredClone?.(record) ??
  (JSON.parse(JSON.stringify(record)) as PersistedMutation);
