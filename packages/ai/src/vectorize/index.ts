import type { NamespaceScope, RagIndexingResult, RagVectorMatch, RagVectors } from '../rag/types';

/** Structural subset of the current Vectorize binding; native methods remain accessible. */
export interface VectorizeBinding {
  upsert(
    records: {
      id: string;
      values: number[];
      namespace: string;
      metadata: Record<string, string>;
    }[],
  ): Promise<{ mutationId: string }>;
  deleteByIds(ids: string[]): Promise<{ mutationId: string }>;
  getByIds(
    ids: string[],
  ): Promise<ReadonlyArray<{ id: string; namespace?: string; metadata?: Record<string, unknown> }>>;
  query(
    vector: number[],
    options: { namespace: string; topK: number; returnValues: false; returnMetadata: 'all' },
  ): Promise<{
    matches: ReadonlyArray<{
      id: string;
      score: number;
      namespace?: string;
      metadata?: Record<string, unknown>;
    }>;
  }>;
  describe(): Promise<{
    dimensions: number;
    vectorCount: number;
    processedUpToMutation: unknown;
    processedUpToDatetime: unknown;
  }>;
}
export interface VectorizeOptions {
  dimensions: number;
  /** Must match the pre-existing index configuration; Scores normalize to nonnegative similarity for importance weighting. */
  metric: 'cosine' | 'euclidean' | 'dot-product';
}
const encoder = new TextEncoder();
const hash = async (value: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};
const validString = (value: unknown, limit: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.isWellFormed() &&
  encoder.encode(value).length <= limit;

/**
 * V2 Vectorize driver. No write receipt, readable ID, or describe watermark is
 * promoted to query visibility. Uses reserved metadata only; application filters
 * belong in authoritative publications. Native filtering is available on binding.
 */
export const vectorizeVectors = <T extends VectorizeBinding>(
  binding: T,
  options: VectorizeOptions,
): RagVectors & {
  readonly binding: T;
  getByIds(
    ids: ReadonlyArray<string>,
    scope: NamespaceScope,
  ): Promise<ReadonlyArray<{ id: string }>>;
} => {
  if (!Number.isInteger(options.dimensions) || options.dimensions < 1 || options.dimensions > 1536)
    throw new Error('Vectorize dimensions must be 1..1536');
  if (!['cosine', 'euclidean', 'dot-product'].includes(options.metric))
    throw new Error('Invalid Vectorize metric');
  const partition = async (scope: NamespaceScope): Promise<string> => {
    if (scope.namespace !== undefined && !validString(scope.namespace, 4096))
      throw new Error('Invalid Vectorize logical namespace');
    return hash(['vela-vectorize-v1', scope.namespace ?? null]);
  };
  const physicalId = (namespace: string, id: string): Promise<string> => {
    if (!validString(id, 4096)) throw new Error('Invalid Vectorize logical ID');
    return hash(['vela-vectorize-v1', namespace, id]);
  };
  const values = (vector: ReadonlyArray<number>): number[] => {
    if (
      !Array.isArray(vector) ||
      vector.length !== options.dimensions ||
      [...vector].some((value) => !Number.isFinite(value) || !Number.isFinite(Math.fround(value)))
    )
      throw new Error('Invalid Vectorize vector dimensions or float32 values');
    return [...vector];
  };
  const result = (mutationIds: string[]): RagIndexingResult => ({
    status: 'accepted',
    mutationIds,
  });
  const mutationId = (receipt: { mutationId: string }): string => {
    if (!validString(receipt.mutationId, 128))
      throw new Error('Invalid Vectorize mutation receipt; submission outcome is unknown');
    return receipt.mutationId;
  };
  const decode = async (
    record: { id: string; namespace?: string; metadata?: Record<string, unknown> },
    namespace: string,
  ): Promise<string | undefined> => {
    const id = record.metadata?.['vela_id'];
    if (
      !validString(id, 4096) ||
      record.namespace !== namespace ||
      record.metadata?.['vela_partition'] !== namespace
    )
      return undefined;
    if (record.id !== (await physicalId(namespace, id))) return undefined;
    return id;
  };
  return {
    binding,
    maxTopK: 50,
    async upsert(records, scope) {
      if (records.length > 4096)
        throw new Error('Vectorize adapter accepts at most 4096 records per call');
      const namespace = await partition(scope);
      // Validate the complete call before submitting its first batch.
      const prepared = await Promise.all(
        records.map(async (record) => {
          const metadata = { vela_id: record.id, vela_partition: namespace };
          if (encoder.encode(JSON.stringify(metadata)).length > 10 * 1024)
            throw new Error('Vectorize metadata exceeds 10 KiB after JSON encoding');
          return {
            id: await physicalId(namespace, record.id),
            namespace,
            values: values(record.vector),
            metadata,
          };
        }),
      );
      const receipts: string[] = [];
      for (let i = 0; i < prepared.length; i += 1000) {
        // oxlint-disable-next-line eslint/no-await-in-loop
        receipts.push(mutationId(await binding.upsert(prepared.slice(i, i + 1000))));
      }
      return result(receipts);
    },
    async query(query) {
      if (!Number.isInteger(query.topK) || query.topK < 1 || query.topK > 50)
        throw new Error('Vectorize adapter topK must be 1..50');
      const namespace = await partition(query);
      const response = await binding.query(values(query.vector), {
        namespace,
        topK: query.topK,
        returnValues: false,
        returnMetadata: 'all',
      });
      if (!Array.isArray(response.matches)) throw new Error('Invalid Vectorize query response');
      const output: RagVectorMatch[] = [];
      for (const match of response.matches.slice(0, query.topK)) {
        // oxlint-disable-next-line eslint/no-await-in-loop
        const id = await decode(match, namespace);
        if (id !== undefined && Number.isFinite(match.score)) {
          if (options.metric === 'euclidean' && match.score < 0) continue;
          const score =
            options.metric === 'euclidean'
              ? 1 / (1 + match.score)
              : options.metric === 'cosine'
                ? Math.max(0, Math.min(1, (match.score + 1) / 2))
                : Math.max(match.score, 0) + Math.log1p(Math.exp(-Math.abs(match.score)));
          output.push({ id, score });
        }
      }
      return output;
    },
    async getByIds(ids, scope) {
      if (ids.length > 4096) throw new Error('Vectorize adapter accepts at most 4096 IDs per call');
      const namespace = await partition(scope);
      const physical = await Promise.all(ids.map((id) => physicalId(namespace, id)));
      const requested = new Set(ids);
      const output: { id: string }[] = [];
      // Conservative 100-ID batches; the binding documents no namespace parameter.
      for (let i = 0; i < physical.length; i += 100) {
        // oxlint-disable-next-line eslint/no-await-in-loop
        const records = await binding.getByIds(physical.slice(i, i + 100));
        if (!Array.isArray(records)) throw new Error('Invalid Vectorize by-ID response');
        for (const record of records.slice(0, 100)) {
          // oxlint-disable-next-line eslint/no-await-in-loop
          const id = await decode(record, namespace);
          if (id !== undefined && requested.has(id)) output.push({ id });
        }
      }
      return output;
    },
    async deleteByIds(ids, scope) {
      if (ids.length > 4096) throw new Error('Vectorize adapter accepts at most 4096 IDs per call');
      const namespace = await partition(scope);
      const physical = await Promise.all(ids.map((id) => physicalId(namespace, id)));
      const receipts: string[] = [];
      for (let i = 0; i < physical.length; i += 100) {
        // oxlint-disable-next-line eslint/no-await-in-loop
        receipts.push(mutationId(await binding.deleteByIds(physical.slice(i, i + 100))));
      }
      return result(receipts);
    },
  };
};
export { durableObjectPublications } from './publications';
export type { DurablePublicationStorage, DurablePublicationTransaction } from './publications';
