import { expect, it } from 'vitest';
import { memoryVectors } from '../rag';
it('isolates IDs and ranks cosine scores; synchronous writes report visibility', async () => {
  const vectors = memoryVectors();
  const record = { id: 'same', vector: [1, 0] };
  expect(await vectors.upsert([record], { namespace: 'a' })).toEqual({
    status: 'visible',
    mutationIds: [],
  });
  record.vector[0] = 0;
  await vectors.upsert([{ id: 'same', vector: [0, 1] }], { namespace: 'b' });
  expect(await vectors.query({ namespace: 'a', vector: [1, 0], topK: 5 })).toEqual([
    { id: 'same', score: 1 },
  ]);
  expect(await vectors.query({ namespace: 'b', vector: [1, 0], topK: 5 })).toEqual([
    { id: 'same', score: 0.5 },
  ]);
  await vectors.deleteByIds(['same'], { namespace: 'a' });
  expect(await vectors.query({ namespace: 'a', vector: [1, 0], topK: 5 })).toEqual([]);
  expect(await vectors.query({ namespace: 'b', vector: [0, 1], topK: 5 })).toHaveLength(1);
});
