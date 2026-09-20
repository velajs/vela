import type { MutationStore, PersistedMutation } from '@velajs/client';
import type { AsyncStorageLike } from './types';

/** Default key the whole persisted-mutation array serializes under. */
export const DEFAULT_MUTATION_STORE_KEY = 'velajs.mutations';

/**
 * A durable {@link MutationStore} backed by one account-epoch-namespaced
 * {@link AsyncStorageLike} key per authenticated partition.
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
  const mirrors = new Map<string, PersistedMutation[]>();
  let tail: Promise<unknown> = Promise.resolve();

  const partitionKey = (account: string): string => `${key}:${encodeURIComponent(account)}`;
  const seed = async (account: string): Promise<PersistedMutation[]> => {
    let mirror = mirrors.get(account);
    if (mirror === undefined) {
      mirror = decodeRecords(await storage.getItem(partitionKey(account)));
      mirrors.set(account, mirror);
    }
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
    append(record, { account }) {
      return chain(async () => {
        const records = await seed(account);
        records.push(clone(record));
        await storage.setItem(partitionKey(account), JSON.stringify(records));
      });
    },
    load({ account }) {
      return chain(async () => {
        const records = await seed(account);
        return records.map(clone);
      });
    },
    remove(id, { account }) {
      return chain(async () => {
        const records = await seed(account);
        const mirror = records.filter((record) => record.id !== id);
        mirrors.set(account, mirror);
        await storage.setItem(partitionKey(account), JSON.stringify(mirror));
      });
    },
    clear({ account }) {
      return chain(async () => {
        mirrors.delete(account);
        await storage.removeItem(partitionKey(account));
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
