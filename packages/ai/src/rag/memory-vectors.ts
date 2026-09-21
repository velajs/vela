import type {
  NamespaceScope,
  RagStoredVector,
  RagVectorMatch,
  RagVectorQuery,
  RagVectorRecord,
  RagVectors,
} from './types';

/** Cosine similarity of two equal-length vectors; 0 when either has zero norm. */
const cosineSimilarity = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
  const length = a.length;
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);

  return denominator === 0 ? 0 : dot / denominator;
};

/** A stored entry keeps its vector and a defensive copy of its metadata. */
interface MemoryEntry {
  vector: ReadonlyArray<number>;
  metadata: Record<string, unknown> | undefined;
}

/**
 * Does `metadata` satisfy every key of `filter` by strict equality? A missing
 * key fails the predicate. Intended for scalar equality — the common tenant/RBAC
 * filter shape — not deep structural matching.
 */
const matchesFilter = (
  metadata: Record<string, unknown> | undefined,
  filter: Record<string, unknown> | undefined,
): boolean => {
  if (filter === undefined) {
    return true;
  }

  for (const [key, value] of Object.entries(filter)) {
    if (metadata === undefined || !Object.hasOwn(metadata, key) || metadata[key] !== value) {
      return false;
    }
  }

  return true;
};

const cloneMetadata = (
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => (metadata === undefined ? undefined : { ...metadata });

/**
 * An in-memory {@link RagVectors} adapter using cosine similarity, partitioned by
 * namespace. It is the reference implementation for tests and local development
 * — everything lives in a `Map` and is lost on restart. Do NOT use it in
 * production; plug a durable store (Vectorize, pgvector, …) behind the same
 * {@link RagVectors} interface instead.
 */
export const memoryVectors = (): RagVectors => {
  // namespace partition -> (id -> entry). The partition boundary is the
  // tenant-isolation guarantee: a query only ever scans its own namespace.
  const partitions = new Map<string, Map<string, MemoryEntry>>();
  const shared = new Map<string, MemoryEntry>();

  const partitionOf = (options: NamespaceScope): Map<string, MemoryEntry> => {
    if (options.namespace === undefined) return shared;
    const key = options.namespace;
    let partition = partitions.get(key);

    if (partition === undefined) {
      partition = new Map();
      partitions.set(key, partition);
    }

    return partition;
  };

  return {
    upsert: async (records: ReadonlyArray<RagVectorRecord>, options: NamespaceScope) => {
      const partition = partitionOf(options);

      for (const record of records) {
        partition.set(record.id, {
          vector: [...record.vector],
          metadata: cloneMetadata(record.metadata),
        });
      }
    },

    query: async (query: RagVectorQuery): Promise<ReadonlyArray<RagVectorMatch>> => {
      const partition = query.namespace === undefined ? shared : partitions.get(query.namespace);

      if (partition === undefined) {
        return [];
      }

      const withMetadata = query.returnMetadata !== 'none';
      const scored: RagVectorMatch[] = [];

      for (const [id, entry] of partition) {
        if (
          entry.vector.length !== query.vector.length ||
          !matchesFilter(entry.metadata, query.filter)
        ) {
          continue;
        }

        const match: RagVectorMatch = {
          id,
          score: cosineSimilarity(query.vector, entry.vector),
        };

        if (withMetadata && entry.metadata !== undefined) {
          match.metadata = { ...entry.metadata };
        }

        scored.push(match);
      }

      scored.sort((left, right) => right.score - left.score);

      return scored.slice(0, Math.max(0, query.topK));
    },

    getByIds: async (
      ids: ReadonlyArray<string>,
      options: NamespaceScope,
    ): Promise<ReadonlyArray<RagStoredVector>> => {
      const partition =
        options.namespace === undefined ? shared : partitions.get(options.namespace);

      if (partition === undefined) {
        return [];
      }

      const found: RagStoredVector[] = [];

      for (const id of ids) {
        const entry = partition.get(id);

        if (entry !== undefined) {
          const record: RagStoredVector = { id };
          const metadata = cloneMetadata(entry.metadata);

          if (metadata !== undefined) {
            record.metadata = metadata;
          }

          found.push(record);
        }
      }

      return found;
    },

    deleteByIds: async (ids: ReadonlyArray<string>, options: NamespaceScope) => {
      const partition =
        options.namespace === undefined ? shared : partitions.get(options.namespace);

      if (partition === undefined) {
        return;
      }

      for (const id of ids) {
        partition.delete(id);
      }
    },
  };
};
