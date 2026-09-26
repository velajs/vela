import type { VectorizeBinding } from '../vectorize';
type NativeRecord = Parameters<VectorizeBinding['upsert']>[0][number];
/** Controllable simulator, deliberately permitting stale, reordered search mutations. */
export const delayedVectorize = () => {
  const readable = new Map<string, NativeRecord>();
  const indexed = new Map<string, NativeRecord>();
  const mutations: (() => void)[] = [];
  let sequence = 0;
  const binding: VectorizeBinding = {
    async upsert(records) {
      const copied = structuredClone(records);
      for (const record of copied) readable.set(record.id, record);
      mutations.push(() => {
        for (const record of copied) indexed.set(record.id, record);
      });
      return { mutationId: `mutation-${++sequence}` };
    },
    async deleteByIds(ids) {
      for (const id of ids) readable.delete(id);
      mutations.push(() => {
        for (const id of ids) indexed.delete(id);
      });
      return { mutationId: `mutation-${++sequence}` };
    },
    async getByIds(ids) {
      return ids.flatMap((id) => {
        const record = readable.get(id);
        return record ? [record] : [];
      });
    },
    async query(_vector, options) {
      return {
        matches: [...indexed.values()]
          .filter((record) => record.namespace === options.namespace)
          .slice(0, options.topK)
          .map((record) => ({ ...record, score: 0.8 })),
      };
    },
    async describe() {
      return {
        dimensions: 1,
        vectorCount: readable.size,
        processedUpToMutation: `mutation-${sequence}`,
        processedUpToDatetime: new Date().toISOString(),
      };
    },
  };
  return {
    binding,
    readable,
    indexed,
    mutations,
    flush: () => {
      for (const apply of mutations.splice(0)) apply();
    },
  };
};
