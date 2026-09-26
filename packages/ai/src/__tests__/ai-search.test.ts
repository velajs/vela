import { asSchema } from 'ai';
import type { AiSearchNamespace } from '@cloudflare/workers-types';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createAiSearch } from '../ai-search';
import type { AiSearchBinding, AiSearchConfig } from '../ai-search';

const execution = { toolCallId: 'search', messages: [], context: {} };
const hit = (instance = 'tenant-a', key = 'guide/v1.md', text = 'Passage') => ({
  instance_id: instance,
  id: 'chunk-1',
  type: 'text',
  text,
  score: 0.8,
  item: { key, metadata: { acl: 'public' } },
});
const setup = (response: unknown = { chunks: [hit()] }, options: Partial<AiSearchConfig> = {}) => {
  const binding = { search: vi.fn(async () => response) };
  const authorizeSource = vi.fn(() => true);
  return {
    binding,
    authorizeSource,
    search: createAiSearch({
      binding,
      instanceIds: ['tenant-a'],
      authorizeSource,
      ...options,
    }),
  };
};

describe('AI Search managed retrieval', () => {
  it('accepts the current native namespace binding without a cast or SDK dependency', () => {
    expectTypeOf<AiSearchNamespace>().toExtend<AiSearchBinding>();
  });

  it('uses namespace search and trusted cross-instance authority, with attributable passages', async () => {
    const { search, binding, authorizeSource } = setup(
      { chunks: [hit(), hit('shared')] },
      {
        instanceIds: ['tenant-a', 'shared'],
        maxResults: 5,
      },
    );
    const result = await search.retrieve('question');
    expect(binding.search).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'question' }],
      ai_search_options: {
        instance_ids: ['tenant-a', 'shared'],
        retrieval: { max_num_results: 5, context_expansion: 0, return_on_failure: false },
        cache: { enabled: false },
      },
    });
    expect(authorizeSource.mock.calls).toEqual([
      [{ instanceId: 'tenant-a', key: 'guide/v1.md' }],
      [{ instanceId: 'shared', key: 'guide/v1.md' }],
    ]);
    expect(result.context).toBe('[source:1]\nPassage\n\n[source:2]\nPassage');
    expect(result.citations).toEqual([
      { id: '1', instanceId: 'tenant-a', key: 'guide/v1.md', chunkId: 'chunk-1' },
      { id: '2', instanceId: 'shared', key: 'guide/v1.md', chunkId: 'chunk-1' },
    ]);
    expect(result.chunks.map((chunk) => chunk.citation)).toEqual(result.citations);
    expect(result).not.toHaveProperty('search_query');
  });

  it('drops results outside the authorized instance set before consulting policy', async () => {
    const { search, authorizeSource } = setup({ chunks: [hit('tenant-b'), hit()] });
    expect((await search.retrieve('q')).chunks).toHaveLength(1);
    expect(authorizeSource).toHaveBeenCalledTimes(1);
  });

  it('rechecks ACLs, immutable revision publication, and tombstones on each tool invocation', async () => {
    let publishedKey: string | undefined = 'guide/v1.md';
    let canRead = true;
    const authorizeSource = vi.fn(({ key }: { key: string }) => canRead && key === publishedKey);
    const { search } = setup(
      { chunks: [hit(), hit('tenant-a', 'guide/v2.md', 'Replacement')] },
      { authorizeSource },
    );
    const tool = search.asTool();
    const query = () => tool.execute!({ query: 'q' }, execution);
    expect(await query()).toMatchObject({ chunks: [{ text: 'Passage' }] });
    publishedKey = 'guide/v2.md';
    expect(await query()).toMatchObject({ chunks: [{ text: 'Replacement' }] });
    canRead = false;
    expect(await query()).toEqual({ context: '', chunks: [], citations: [] });
    canRead = true;
    publishedKey = undefined;
    expect(await query()).toEqual({ context: '', chunks: [], citations: [] });
    expect(authorizeSource).toHaveBeenCalledTimes(8);
  });

  it('snapshots configuration and isolates overlapping environments and identities', async () => {
    const ids = ['tenant-a'];
    const a = setup({ chunks: [hit()] }, { instanceIds: ids });
    const b = setup(
      { chunks: [hit('tenant-b', 'guide/v1.md', 'Private B')] },
      { instanceIds: ['tenant-b'] },
    );
    ids[0] = 'tenant-b';
    const results = await Promise.all([a.search.retrieve('q'), b.search.retrieve('q')]);
    expect(results.map((result) => result.chunks[0]?.text)).toEqual(['Passage', 'Private B']);
    expect(a.binding.search.mock.calls[0]).toMatchObject([
      { ai_search_options: { instance_ids: ['tenant-a'] } },
    ]);
  });

  it('preserves the native binding receiver and recreates request arrays', async () => {
    const binding = {
      marker: true,
      async search(request: Parameters<AiSearchBinding['search']>[0]) {
        expect(this.marker).toBe(true);
        expect(request.ai_search_options.instance_ids).toEqual(['tenant-a']);
        request.ai_search_options.instance_ids.push('tenant-b');
        return { chunks: [] };
      },
    };
    const { search } = setup(undefined, { binding });
    await search.retrieve('q');
    await search.retrieve('q');
  });

  it('requires a literal true authorization and fails closed on authority errors', async () => {
    const untyped = JSON.parse('"yes"');
    expect(
      (await setup(undefined, { authorizeSource: () => untyped }).search.retrieve('q')).chunks,
    ).toEqual([]);
    const { search } = setup(undefined, {
      authorizeSource: () => {
        throw new Error('authority unavailable');
      },
    });
    await expect(search.retrieve('q')).rejects.toThrow('authority unavailable');
  });

  it.each([
    null,
    {},
    { chunks: {} },
    { chunks: [], errors: {} },
    { chunks: [hit()], errors: [{ instance_id: 'tenant-a', message: 'failure' }] },
  ])('rejects malformed envelopes and partial failures: %j', async (response) => {
    const { search, authorizeSource } = setup(response);
    await expect(search.retrieve('q')).rejects.toThrow('@velajs/ai/ai-search');
    expect(authorizeSource).not.toHaveBeenCalled();
  });

  it('does not convert native failures into empty success', async () => {
    const { search } = setup(undefined, {
      binding: {
        search: async () => {
          throw new Error('native failure');
        },
      },
    });
    await expect(search.retrieve('q')).rejects.toThrow('native failure');
  });

  it('drops malformed, oversized, inherited and accessor-backed chunks', async () => {
    const getter = vi.fn(() => 'secret');
    const invalid = [
      null,
      { ...hit(), score: NaN },
      { ...hit(), score: 2 },
      { ...hit(), score: -1 },
      { ...hit(), type: 'image' },
      { ...hit(), id: '\ud800' },
      { ...hit(), text: '🌎'.repeat(17000) },
      { ...hit(), item: { key: 'x'.repeat(4097) } },
      Object.create(hit()),
      Object.defineProperty(hit(), 'text', { get: getter }),
    ];
    const { search } = setup({ chunks: [...invalid, hit()] }, { maxResults: 50 });
    expect((await search.retrieve('q')).chunks).toHaveLength(1);
    expect(getter).not.toHaveBeenCalled();
  });

  it('does not inspect or return arbitrary service metadata and handles opaque citation keys', async () => {
    const getter = vi.fn(() => {
      throw new Error('must not inspect metadata');
    });
    const chunk = hit('tenant-a', 'guide]\n[source:99]/文.md');
    Object.defineProperty(chunk.item, 'metadata', { get: getter });
    const { search } = setup({ chunks: [chunk] });
    const result = await search.retrieve('q');
    expect(result.context).toBe('[source:1]\nPassage');
    expect(result.citations[0]?.key).toBe(chunk.item.key);
    expect(getter).not.toHaveBeenCalled();
  });

  it('bounds response inspection, deduplicates chunks, and authorizes each item once per retrieval', async () => {
    const excess = vi.fn(() => {
      throw new Error('excess inspected');
    });
    const chunks = [hit(), hit(), { ...hit(), id: 'chunk-2' }];
    Object.defineProperty(chunks, '3', { get: excess });
    const { search, authorizeSource } = setup({ chunks }, { maxResults: 3 });
    expect((await search.retrieve('q')).chunks).toHaveLength(2);
    expect(authorizeSource).toHaveBeenCalledTimes(1);
    expect(excess).not.toHaveBeenCalled();
  });

  it('bounds assembled UTF-8 context without orphaned citations', async () => {
    const chunks = Array.from({ length: 50 }, (_, n) => ({
      ...hit(),
      id: String(n),
      text: 'a'.repeat(64 * 1024),
    }));
    const result = await setup({ chunks }, { maxResults: 50 }).search.retrieve('q');
    expect(new TextEncoder().encode(result.context).byteLength).toBeLessThanOrEqual(512 * 1024);
    expect(result.chunks).toHaveLength(7);
    expect(result.citations).toHaveLength(7);
  });

  it.each(['', ' ', '🌎'.repeat(9000), '\ud800'])(
    'rejects invalid queries before native calls',
    async (query) => {
      const { search, binding } = setup();
      await expect(search.retrieve(query)).rejects.toThrow('query');
      expect(binding.search).not.toHaveBeenCalled();
    },
  );

  it('validates tool schema and direct execution, with no model-controlled authority', async () => {
    const { search, binding } = setup();
    const tool = search.asTool();
    const schema = asSchema(tool.inputSchema);
    const inputs = [
      null,
      {},
      { query: 'q', instanceIds: ['tenant-b'] },
      { query: 'q', auth: {} },
      { query: 'q', maxResults: 50 },
      { query: '🌎'.repeat(9000) },
    ];
    await Promise.all(
      inputs.map(async (input) => {
        expect(await schema.validate?.(input)).toMatchObject({ success: false });
        // Exercise the runtime boundary even for JavaScript callers bypassing SDK validation.
        await expect(tool.execute!(input as { query: string }, execution)).rejects.toThrow();
      }),
    );
    expect(binding.search).not.toHaveBeenCalled();
    expect(await schema.validate?.({ query: 'q' })).toMatchObject({ success: true });
    expect(await tool.execute!({ query: 'q' }, execution)).toMatchObject({
      chunks: [{ text: 'Passage' }],
    });
  });

  it.each([
    { instanceIds: [] },
    { instanceIds: Array.from({ length: 11 }, (_, n) => String(n)) },
    { instanceIds: ['a', 'a'] },
    { instanceIds: [' a'] },
    { instanceIds: ['🌎'.repeat(100)] },
    { maxResults: 0 },
    { maxResults: 51 },
    { maxResults: 1.5 },
  ])('rejects invalid server configuration: %j', (options) => {
    expect(() => setup(undefined, options)).toThrow('@velajs/ai/ai-search');
  });
});
