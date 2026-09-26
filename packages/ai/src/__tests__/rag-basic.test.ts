import { describe, expect, it } from 'vitest';
import { defineRag, memoryVectors, memoryPublications } from '../rag';
import { keywordEmbedder, pipeSplitter } from './support';

describe('defineRag — authoritative sync + retrieve', () => {
  it('chunks, embeds, upserts, and retrieves prompt-ready context', async () => {
    const rag = defineRag({
      publications: memoryPublications(),
      name: 'basic-metadata',
      vectors: memoryVectors(),
      embed: keywordEmbedder(),
      chunk: pipeSplitter,
      allowSharedNamespace: true,
    });

    const results = await rag.sync([
      { id: 'doc-a', text: 'alpha topic|beta topic', metadata: { title: 'A' } },
      { id: 'doc-b', text: 'gamma topic', metadata: { title: 'B' } },
    ]);

    expect(results[0]?.chunks).toBe(2);
    expect(results[0]?.unchanged).toBe(false);
    expect(results[1]?.chunks).toBe(1);

    const found = await rag.retrieve('alpha', { topK: 3 });

    expect(found.chunks.length).toBeGreaterThan(0);
    expect(found.chunks[0]?.sourceId).toBe('doc-a');
    expect(found.chunks[0]?.text).toContain('alpha');
    // Metadata comes from the current authoritative publication.
    expect(found.chunks[0]?.metadata).toEqual({ title: 'A' });
    expect(JSON.stringify(found.chunks[0]?.metadata)).not.toContain('@velajs/ai:rag');
    // Prompt context carries an attributable source header.
    expect(found.context).toContain('[source:doc-a#0]');
    // Sources are deduped, best-first.
    expect(found.sources[0]).toMatchObject({ id: 'doc-a', weight: 1 });
  });

  it('retrieves authoritative text without vector metadata', async () => {
    const rag = defineRag({
      publications: memoryPublications(),
      name: 'basic-textstore',
      vectors: memoryVectors(),

      embed: keywordEmbedder(),
      chunk: pipeSplitter,
      allowSharedNamespace: true,
    });

    await rag.sync([{ id: 'doc', text: 'alpha one|beta two|gamma three' }]);

    const found = await rag.retrieve('beta', { topK: 1 });

    expect(found.chunks[0]?.text).toBe('beta two');
  });

  it('remove() deletes every chunk of a source', async () => {
    const rag = defineRag({
      publications: memoryPublications(),
      name: 'basic-remove',
      vectors: memoryVectors(),
      embed: keywordEmbedder(),
      chunk: pipeSplitter,
      allowSharedNamespace: true,
    });

    await rag.sync([{ id: 'doc', text: 'alpha|beta|gamma' }]);
    expect((await rag.retrieve('alpha', { topK: 5 })).chunks.length).toBeGreaterThan(0);

    await rag.remove('doc', { expectedRevision: (await rag.inspect('doc'))!.revision });

    expect((await rag.retrieve('alpha', { topK: 5 })).chunks).toHaveLength(0);
  });

  it('exposes retrieve as an AI SDK tool wired to the index', async () => {
    const rag = defineRag({
      publications: memoryPublications(),
      name: 'basic-tool',
      vectors: memoryVectors(),
      embed: keywordEmbedder(),
      allowSharedNamespace: true,
    });

    await rag.sync([{ id: 'doc', text: 'alpha beta gamma' }]);

    const searchTool = rag.asTool({ description: 'Search the docs' });
    expect(searchTool.description).toBe('Search the docs');
    expect(searchTool.inputSchema).toBeDefined();
    expect(typeof searchTool.execute).toBe('function');

    // The default description names the index.
    const defaultTool = rag.asTool();
    expect(defaultTool.description).toContain('basic-tool');
  });
});
