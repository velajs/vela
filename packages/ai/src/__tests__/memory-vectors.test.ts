import { expect, it } from 'vitest';
import { memoryVectors } from '../rag';

it('does not compare vectors in incompatible dimensional spaces', async () => {
  const vectors = memoryVectors();
  await vectors.upsert([{ id: 'two', vector: [1, 1] }], {});
  expect(await vectors.query({ vector: [1], topK: 5 })).toEqual([]);
  expect(await vectors.query({ vector: [1, 1], topK: 5 })).toMatchObject([{ id: 'two' }]);
});
