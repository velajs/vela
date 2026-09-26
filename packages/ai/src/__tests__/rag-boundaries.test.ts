import { describe, expect, it } from 'vitest';
import { defineRag, memoryVectors, memoryPublications } from '../rag';
import type { RagVectorMatch, RagVectors } from '../rag';
import { keywordEmbedder } from './support';

describe('defineRag — untrusted boundary limits', () => {
  it('bounds custom chunker count, per-chunk bytes, and aggregate bytes', async () => {
    const tooMany = defineRag({
      publications: memoryPublications(),
      vectors: memoryVectors(),
      embed: keywordEmbedder(),
      chunk: () => Array.from({ length: 4097 }, () => 'alpha'),
      allowSharedNamespace: true,
    });
    await expect(tooMany.sync([{ id: 'doc', text: 'alpha' }])).rejects.toThrow(/4096/);

    const tooLarge = defineRag({
      publications: memoryPublications(),
      vectors: memoryVectors(),
      embed: keywordEmbedder(),
      chunk: () => ['x'.repeat(64 * 1024 + 1)],
      allowSharedNamespace: true,
    });
    await expect(tooLarge.sync([{ id: 'doc', text: 'alpha' }])).rejects.toThrow(/65536/);

    const tooLargeInAggregate = defineRag({
      publications: memoryPublications(),
      vectors: memoryVectors(),
      embed: keywordEmbedder(),
      chunk: () => Array.from({ length: 65 }, () => 'x'.repeat(64 * 1024)),
      allowSharedNamespace: true,
    });
    await expect(tooLargeInAggregate.sync([{ id: 'doc', text: 'alpha' }])).rejects.toThrow(
      /aggregate limit/,
    );
  });

  it('rejects oversized or executable document metadata before hashing', async () => {
    const rag = defineRag({
      publications: memoryPublications(),
      vectors: memoryVectors(),
      embed: keywordEmbedder(),
      allowSharedNamespace: true,
    });

    await expect(
      rag.sync([{ id: 'large', text: 'alpha', metadata: { value: 'x'.repeat(64 * 1024) } }]),
    ).rejects.toThrow(/metadata.*bounded plain JSON/);

    const metadata = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(metadata, 'secret', {
      enumerable: true,
      get: () => {
        throw new Error('getter must not execute');
      },
    });
    await expect(rag.sync([{ id: 'getter', text: 'alpha', metadata }])).rejects.toThrow(
      /bounded plain JSON/,
    );
  });

  it('validates embedder output dimensions and finite values', async () => {
    const nonFinite = defineRag({
      publications: memoryPublications(),
      vectors: memoryVectors(),
      embed: () => [Number.NaN],
      allowSharedNamespace: true,
    });
    await expect(nonFinite.sync([{ id: 'doc', text: 'alpha' }])).rejects.toThrow(/finite/);

    const tooWide = defineRag({
      publications: memoryPublications(),
      vectors: memoryVectors(),
      embed: () => Array.from({ length: 8193 }, () => 0),
      allowSharedNamespace: true,
    });
    await expect(tooWide.sync([{ id: 'doc', text: 'alpha' }])).rejects.toThrow(/8192/);
  });

  it('rejects malformed Unicode identifiers before percent-encoding them', async () => {
    const rag = defineRag({
      publications: memoryPublications(),
      vectors: memoryVectors(),
      embed: keywordEmbedder(),
      allowSharedNamespace: true,
    });

    await expect(rag.sync([{ id: '\uD800', text: 'alpha' }])).rejects.toThrow(/source ids/);
  });

  it('re-applies scalar ACL filters when a vector adapter ignores them', async () => {
    const base = memoryVectors();
    const vectors: RagVectors = {
      ...base,
      query: (query) => base.query({ ...query, topK: 100 }),
    };
    const rag = defineRag({
      publications: memoryPublications(),
      vectors,
      embed: keywordEmbedder(),
      allowSharedNamespace: true,
      rlsFilter: (auth) => {
        if (auth === null || typeof auth !== 'object') return { org: 'denied' };
        const descriptor = Object.getOwnPropertyDescriptor(auth, 'org');
        return {
          org: descriptor !== undefined && 'value' in descriptor ? descriptor.value : 'denied',
        };
      },
    });
    await rag.sync([
      { id: 'mine', text: 'alpha', metadata: { org: 'a' } },
      { id: 'theirs', text: 'alpha', metadata: { org: 'b' } },
    ]);

    const result = await rag.retrieve('alpha', { auth: { org: 'a' }, topK: 10 });
    expect(result.sources.map((source) => source.id)).toEqual(['mine']);
  });

  it('slices over-returning adapters before inspecting excess entries', async () => {
    const base = memoryVectors();
    const bomb: RagVectorMatch = {
      get id(): string {
        throw new Error('excess match was inspected');
      },
      score: 1,
    };
    const vectors: RagVectors = {
      ...base,
      query: async (query) => [...(await base.query(query)), bomb],
    };
    const rag = defineRag({
      publications: memoryPublications(),
      vectors,
      embed: keywordEmbedder(),
      allowSharedNamespace: true,
    });
    await rag.sync([{ id: 'doc', text: 'alpha' }]);

    await expect(rag.retrieve('alpha', { topK: 1 })).resolves.toMatchObject({
      sources: [{ id: 'doc' }],
    });
  });

  it('caps assembled retrieval context even when many maximum-sized chunks match', async () => {
    const rag = defineRag({
      publications: memoryPublications(),
      vectors: memoryVectors(),
      embed: keywordEmbedder(),
      chunk: () =>
        Array.from({ length: 40 }, (_, index) => `alpha-${index}-${'x'.repeat(60 * 1024)}`),
      allowSharedNamespace: true,
    });
    await rag.sync([{ id: 'doc', text: 'alpha' }]);

    const result = await rag.retrieve('alpha', { topK: 40 });
    expect(new TextEncoder().encode(result.context).byteLength).toBeLessThanOrEqual(
      2 * 1024 * 1024,
    );
    expect(result.chunks.length).toBeLessThan(40);
  });
});
