import { expect, it } from 'vitest';
import { vectorizeVectors } from '../vectorize';
import { defineRag, memoryPublications } from '../rag';
import { delayedVectorize } from './vectorize-support';

it('exposes only eventual receipts, even when by-ID reads and describe have advanced', async () => {
  const native = delayedVectorize();
  const vectors = vectorizeVectors(native.binding, { dimensions: 1, metric: 'cosine' });
  expect(vectors.binding).toBe(native.binding);
  expect(
    await vectors.upsert([{ id: 'long/'.repeat(500), vector: [1] }], {
      namespace: 'tenant/'.repeat(200),
    }),
  ).toMatchObject({ status: 'accepted' });
  expect(
    await vectors.getByIds(['long/'.repeat(500)], { namespace: 'tenant/'.repeat(200) }),
  ).toHaveLength(1);
  expect((await vectors.binding.describe()).vectorCount).toBe(1);
  expect(await vectors.query({ namespace: 'tenant/'.repeat(200), vector: [1], topK: 5 })).toEqual(
    [],
  );
  const record = [...native.readable.values()][0]!;
  expect(record.id).toMatch(/^[a-f0-9]{64}$/);
  expect(record.namespace).toMatch(/^[a-f0-9]{64}$/);
  native.flush();
  expect(
    await vectors.query({ namespace: 'tenant/'.repeat(200), vector: [1], topK: 5 }),
  ).toHaveLength(1);
});

it('isolates equal logical IDs for shared and tenant scopes, including native by-ID deletion', async () => {
  const native = delayedVectorize();
  const vectors = vectorizeVectors(native.binding, { dimensions: 1, metric: 'cosine' });
  for (const namespace of [undefined, '\0', 'shared', 'tenant/雪'])
    await vectors.upsert([{ id: 'same', vector: [1] }], { namespace });
  expect(native.readable.size).toBe(4);
  await vectors.deleteByIds(['same'], { namespace: '\0' });
  expect(await vectors.getByIds(['same'], { namespace: '\0' })).toEqual([]);
  expect(await vectors.getByIds(['same'], {})).toEqual([{ id: 'same' }]);
  expect(await vectors.getByIds(['same'], { namespace: 'shared' })).toEqual([{ id: 'same' }]);
});

it('rejects forged/foreign by-ID and query results even when a binding ignores namespace', async () => {
  const native = delayedVectorize();
  const vectors = vectorizeVectors(native.binding, { dimensions: 1, metric: 'cosine' });
  await vectors.upsert([{ id: 'secret', vector: [1] }], { namespace: 'b' });
  const foreign = [...native.readable.values()][0]!;
  native.binding.getByIds = async () => [foreign];
  native.binding.query = async () => ({ matches: [{ ...foreign, score: 1 }] });
  expect(await vectors.getByIds(['secret'], { namespace: 'a' })).toEqual([]);
  expect(await vectors.query({ namespace: 'a', vector: [1], topK: 1 })).toEqual([]);
  foreign.metadata.vela_id = 'forged';
  expect(await vectors.query({ namespace: 'b', vector: [1], topK: 1 })).toEqual([]);
});

it('validates entire batches, JSON metadata bytes, dimensions and topK before mutation', async () => {
  const native = delayedVectorize();
  const vectors = vectorizeVectors(native.binding, { dimensions: 1, metric: 'cosine' });
  await expect(
    vectors.upsert(
      [
        { id: 'valid', vector: [1] },
        { id: '\0'.repeat(4096), vector: [1] },
      ],
      {},
    ),
  ).rejects.toThrow(/10 KiB/);
  expect(native.mutations).toHaveLength(0);
  await expect(vectors.upsert([{ id: 'x', vector: [1e100] }], {})).rejects.toThrow(/float32/);
  await expect(vectors.query({ vector: [1], topK: 51 })).rejects.toThrow(/1..50/);
});

it('reports a partial batch failure as ambiguous, and permits idempotent retry', async () => {
  const native = delayedVectorize();
  const original = native.binding.upsert;
  let calls = 0;
  native.binding.upsert = async (records) => {
    if (++calls === 2) throw new Error('partial');
    return original(records);
  };
  const vectors = vectorizeVectors(native.binding, { dimensions: 1, metric: 'cosine' });
  const records = Array.from({ length: 1001 }, (_, i) => ({ id: `id-${i}`, vector: [1] }));
  await expect(vectors.upsert(records, {})).rejects.toThrow('partial');
  expect(native.readable.size).toBe(1000);
  expect((await vectors.upsert(records, {})).mutationIds).toHaveLength(2);
  expect(native.readable.size).toBe(1001);
});

it('never hydrates stale revisions after ACL replacement or removal, including reordered late writes', async () => {
  const native = delayedVectorize();
  const vectors = vectorizeVectors(native.binding, { dimensions: 1, metric: 'cosine' });
  const rag = defineRag({
    vectors,
    publications: memoryPublications(),
    embed: () => [1],
    allowSharedNamespace: true,
    rlsFilter: (auth) => ({ role: auth }),
  });
  const [first] = await rag.sync([{ id: 'doc', text: 'old text', metadata: { role: 'reader' } }]);
  expect(first?.indexing?.status).toBe('accepted');
  expect((await rag.retrieve('old', { auth: 'reader' })).chunks).toEqual([]);
  native.flush();
  expect((await rag.retrieve('old', { auth: 'reader' })).chunks[0]?.text).toBe('old text');
  const [second] = await rag.sync([
    {
      id: 'doc',
      text: 'new secret',
      metadata: { role: 'admin' },
      expectedRevision: first!.revision,
    },
  ]);
  expect((await rag.retrieve('old', { auth: 'reader' })).chunks).toEqual([]);
  expect((await rag.retrieve('secret', { auth: 'admin' })).chunks).toEqual([]);
  native.flush();
  expect((await rag.retrieve('secret', { auth: 'admin' })).chunks[0]?.text).toBe('new secret');
  const late = [...native.indexed.values()];
  const deleted = await rag.remove('doc', { expectedRevision: second!.revision });
  expect((await rag.retrieve('secret', { auth: 'admin' })).chunks).toEqual([]);
  await rag.reconcile('doc', { revision: deleted.revision });
  native.flush();
  // Simulate writes that were accepted before cancellation but applied after cleanup.
  for (const record of late) native.indexed.set(record.id, record);
  expect((await rag.retrieve('secret', { auth: 'admin' })).chunks).toEqual([]);
  expect((await rag.reconcile('doc', { revision: deleted.revision })).cleanup).toHaveLength(2);
});

it('normalizes euclidean ordering and importance without dropping nonexact matches', async () => {
  const native = delayedVectorize();
  const vectors = vectorizeVectors(native.binding, { dimensions: 1, metric: 'euclidean' });
  const rag = defineRag({
    vectors,
    publications: memoryPublications(),
    embed: () => [1],
    allowSharedNamespace: true,
  });
  await rag.sync([
    { id: 'far', text: 'far' },
    { id: 'near', text: 'near' },
    { id: 'boost', text: 'boost', importance: 2 },
  ]);
  native.flush();
  native.binding.query = async () => ({
    matches: [...native.indexed.values()].map((record, index) => ({
      ...record,
      score: index === 0 ? 9 : 1,
    })),
  });
  const result = await rag.retrieve('q');
  expect(result.chunks.map((chunk) => chunk.sourceId)).toEqual(['boost', 'near', 'far']);
  expect(result.chunks.map((chunk) => chunk.score)).toEqual([1, 0.5, 0.1]);
  expect(
    (await rag.retrieve('q', { minScore: 0.4 })).chunks.map((chunk) => chunk.sourceId),
  ).toEqual(['boost', 'near']);
});
