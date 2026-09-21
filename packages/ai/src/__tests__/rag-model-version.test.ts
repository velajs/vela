import { describe, expect, it } from 'vitest';
import { defineRag, memoryVectors } from '../rag';
import type { RagVectors } from '../rag';
import { keywordEmbedder } from './support';

describe('defineRag — embeddingModelVersion partitioning', () => {
  it('a version bump partitions the vector space (old vectors unreachable to new queries)', async () => {
    const vectors: RagVectors = memoryVectors();
    const embed = keywordEmbedder();

    const v1 = defineRag({
      name: 'model-version',
      vectors,
      embed,
      embeddingModelVersion: 'bge-v1',
      allowSharedNamespace: true,
      resolveNamespace: ({ selector }) => selector,
    });
    const v2 = defineRag({
      name: 'model-version',
      vectors,
      embed,
      embeddingModelVersion: 'bge-v2',
      allowSharedNamespace: true,
      resolveNamespace: ({ selector }) => selector,
    });

    await v1.sync([{ id: 'doc', text: 'alpha beta' }], { namespace: 'tenant' });

    // The new model version sees nothing under the same tenant namespace.
    const crossVersion = await v2.retrieve('alpha', { namespace: 'tenant', topK: 10 });
    expect(crossVersion.chunks).toHaveLength(0);

    // The original version still resolves its own vectors.
    const sameVersion = await v1.retrieve('alpha', { namespace: 'tenant', topK: 10 });
    expect(sameVersion.chunks.length).toBeGreaterThan(0);
  });

  it('rejects an invalid version tag', () => {
    expect(() =>
      defineRag({
        name: 'bad-version',
        vectors: memoryVectors(),
        embed: keywordEmbedder(),
        embeddingModelVersion: 'not valid!',
      }),
    ).toThrow(/embeddingModelVersion/);
  });
});

describe('unambiguous model and tenant partitions', () => {
  it.each(['v1', 'v1::tenant', '@velajs/ai/rag:v1:[null,"v1"]'])(
    'does not alias a tagged index with tenant %s',
    async (tenant) => {
      const vectors = memoryVectors();
      const common = { vectors, embed: keywordEmbedder(), allowSharedNamespace: true };
      const tagged = defineRag({
        ...common,
        embeddingModelVersion: 'v1',
        resolveNamespace: () => (tenant === 'v1::tenant' ? 'tenant' : undefined),
      });
      const untagged = defineRag({ ...common, resolveNamespace: () => tenant });
      await tagged.sync([{ id: 'same', text: 'alpha private' }]);
      expect((await untagged.retrieve('alpha')).chunks).toHaveLength(0);
      await untagged.sync([{ id: 'same', text: 'beta private' }]);
      await untagged.remove('same');
      expect((await tagged.retrieve('alpha')).chunks[0]?.text).toBe('alpha private');
    },
  );
});
