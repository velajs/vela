import { env } from 'cloudflare:workers';
// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import * as test from 'cloudflare:test';
import { expect, it } from 'vitest';
import { vectorizeVectors } from '../../vectorize';
import { delayedVectorize } from '../vectorize-support';

it('persists and resumes a journal after DO eviction, without Node compatibility', async () => {
  const stub = env.PUBLICATIONS.getByName('resume');
  const { source, revision } = await stub.seed();
  const pool: { abortAllDurableObjects(): Promise<void> } = test;
  await pool.abortAllDurableObjects();
  expect((await env.PUBLICATIONS.getByName('resume').resume(source, revision)).length).toBe(60000);
});
it('uses native rollback, closed handles and bounded physical storage records', async () => {
  const result = await env.PUBLICATIONS.getByName('transactions').transactions();
  expect(result).toMatchObject({ absent: true, closed: true, length: 65536 });
  expect(result.largest).toBeLessThan(128 * 1024);
});
it('runs SHA-256 mapped Vectorize adapters on Web APIs in workerd', async () => {
  const native = delayedVectorize();
  const vectors = vectorizeVectors(native.binding, { dimensions: 1, metric: 'cosine' });
  expect((await vectors.upsert([{ id: '雪', vector: [1] }], { namespace: 'tenant' })).status).toBe(
    'accepted',
  );
  native.flush();
  expect(await vectors.query({ vector: [1], namespace: 'tenant', topK: 1 })).toEqual([
    { id: '雪', score: 0.9 },
  ]);
});
