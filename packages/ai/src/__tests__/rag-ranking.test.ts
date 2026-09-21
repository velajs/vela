import { describe, expect, it } from 'vitest';
import { defineRag, memoryVectors } from '../rag';
import { keywordEmbedder, pipeSplitter } from './support';

describe('defineRag — ranking controls', () => {
  it('minScore drops matches below the threshold', async () => {
    const rag = defineRag({
      name: 'rank-minscore',
      vectors: memoryVectors(),
      embed: keywordEmbedder(),
      chunk: pipeSplitter,
      allowSharedNamespace: true,
    });

    await rag.sync([
      { id: 'exact', text: 'alpha' }, // cosine 1.0 vs query "alpha"
      { id: 'diluted', text: 'alpha beta gamma' }, // cosine ~0.577
    ]);

    const strict = await rag.retrieve('alpha', { topK: 10, minScore: 0.9 });
    expect(strict.sources.map((source) => source.id)).toEqual(['exact']);

    const loose = await rag.retrieve('alpha', { topK: 10, minScore: 0 });
    expect(loose.sources.map((source) => source.id).sort()).toEqual(['diluted', 'exact']);
  });

  it('per-document importance re-weights (and reorders) matches', async () => {
    const rag = defineRag({
      name: 'rank-importance',
      vectors: memoryVectors(),
      embed: keywordEmbedder(),
      allowSharedNamespace: true,
    });

    await rag.sync([
      { id: 'incidental', text: 'alpha', importance: 1 },
      { id: 'canonical', text: 'alpha', importance: 2 },
    ]);

    const found = await rag.retrieve('alpha', { topK: 10 });

    // Equal cosine, but the canonical doc's importance boosts it to the top.
    expect(found.chunks[0]?.sourceId).toBe('canonical');
    expect(found.chunks[0]?.score).toBeGreaterThan(found.chunks[1]?.score ?? 0);
    expect(found.chunks[0]?.importance).toBe(2);
    expect(found.sources[0]).toMatchObject({ id: 'canonical', weight: 2 });
  });

  it('rejects a negative importance', async () => {
    const rag = defineRag({
      name: 'rank-bad-importance',
      vectors: memoryVectors(),
      embed: keywordEmbedder(),
      allowSharedNamespace: true,
    });

    await expect(rag.sync([{ id: 'x', text: 'alpha', importance: -1 }])).rejects.toThrow(
      /importance/,
    );
  });

  it('chunkContext stitches neighbouring chunks into each match', async () => {
    const rag = defineRag({
      name: 'rank-context',
      vectors: memoryVectors(),
      embed: keywordEmbedder(),
      chunk: pipeSplitter,
      allowSharedNamespace: true,
    });

    // Chunk 0 = alpha, chunk 1 = beta, chunk 2 = gamma.
    await rag.sync([{ id: 'doc', text: 'alpha here|beta here|gamma here' }]);

    const found = await rag.retrieve('beta', {
      topK: 1,
      chunkContext: { before: 1, after: 1 },
    });

    // The match is the beta chunk, expanded to include its two neighbours.
    const text = found.chunks[0]?.text ?? '';
    expect(text).toContain('alpha here');
    expect(text).toContain('beta here');
    expect(text).toContain('gamma here');
  });

  it('rejects retrieval and context limits above their security caps', async () => {
    const rag = defineRag({
      name: 'rank-limits',
      vectors: memoryVectors(),
      embed: keywordEmbedder(),
      allowSharedNamespace: true,
    });

    await expect(rag.retrieve('alpha', { topK: 101 })).rejects.toThrow(/between 1 and 100/);
    await expect(rag.retrieve('alpha', { chunkContext: { before: 21, after: 0 } })).rejects.toThrow(
      /capped at 20/,
    );
  });
});
