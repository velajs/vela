import type {
  NamespaceScope,
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

  return denominator === 0 ? 0 : Math.max(0, Math.min(1, (dot / denominator + 1) / 2));
};

interface MemoryEntry {
  vector: ReadonlyArray<number>;
}

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
    maxTopK: 100,
    upsert: async (records: ReadonlyArray<RagVectorRecord>, options: NamespaceScope) => {
      const partition = partitionOf(options);

      for (const record of records) {
        partition.set(record.id, {
          vector: [...record.vector],
        });
      }
      return { status: 'visible', mutationIds: [] };
    },

    query: async (query: RagVectorQuery): Promise<ReadonlyArray<RagVectorMatch>> => {
      const partition = query.namespace === undefined ? shared : partitions.get(query.namespace);

      if (partition === undefined) {
        return [];
      }

      const scored: RagVectorMatch[] = [];

      for (const [id, entry] of partition) {
        if (entry.vector.length !== query.vector.length) {
          continue;
        }

        const match: RagVectorMatch = {
          id,
          score: cosineSimilarity(query.vector, entry.vector),
        };

        scored.push(match);
      }

      scored.sort((left, right) => right.score - left.score);

      return scored.slice(0, Math.max(0, query.topK));
    },

    deleteByIds: async (ids: ReadonlyArray<string>, options: NamespaceScope) => {
      const partition =
        options.namespace === undefined ? shared : partitions.get(options.namespace);

      if (partition === undefined) {
        return { status: 'visible', mutationIds: [] };
      }

      for (const id of ids) {
        partition.delete(id);
      }
      return { status: 'visible', mutationIds: [] };
    },
  };
};
