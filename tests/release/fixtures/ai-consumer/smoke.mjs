import assert from 'node:assert/strict';
import * as core from '@velajs/ai';
import * as ragExports from '@velajs/ai/rag';
import { createAiSearch } from '@velajs/ai/ai-search';
import { asSchema } from 'ai';
import { MockLanguageModelV4, MockEmbeddingModelV4 } from 'ai/test';

for (const name of ['createAi', 'generateText', 'streamText', 'embed', 'tool', 'jsonSchema'])
  assert.equal(typeof core[name], 'function');
for (const name of ['defineRag', 'memoryVectors', 'fixedWindowChunks', 'mapWithConcurrency'])
  assert.equal(typeof ragExports[name], 'function');
assert.equal(ragExports.DEFAULT_SYNC_CONCURRENCY, 8);
assert.throws(() => import.meta.resolve('@ai-sdk/openai'), /Cannot find package/);
const model = new MockLanguageModelV4({ modelId: 'local' });
const embedding = new MockEmbeddingModelV4({ modelId: 'local-embedding' });
const models = core.createAi({ defaultModel: model, defaultEmbeddingModel: embedding });
assert.equal(models.model(), model);
assert.equal(models.embeddingModel(), embedding);
assert.throws(() => models.model('unconfigured'), /no `provider`/);
const rag = ragExports.defineRag({
  vectors: ragExports.memoryVectors(),
  embed: () => [1],
  embeddingModelVersion: 'fixture-v1',
  resolveNamespace: ({ auth, selector }) => {
    assert.equal(typeof auth, 'string');
    if (selector !== undefined) assert.equal(selector, auth);
    return auth;
  },
});
await rag.sync([{ id: 'doc', text: 'tenant a' }], { auth: 'a' });
await rag.sync([{ id: 'doc', text: 'tenant b' }], { auth: 'b' });
assert.equal((await rag.retrieve('query', { auth: 'a' })).chunks[0].text, 'tenant a');
assert.equal((await rag.sync([{ id: 'doc', text: 'tenant a' }], { auth: 'a' }))[0].unchanged, true);
await rag.sync([{ id: 'doc', text: 'replacement' }], { auth: 'a' });
const search = rag.asTool({ auth: 'a' });
assert.equal(
  (await asSchema(search.inputSchema).validate({ query: 'x', namespace: 'b' })).success,
  false,
);
const found = await search.execute(
  { query: 'x' },
  { toolCallId: 'check', messages: [], context: {} },
);
assert.equal(found.chunks[0].text, 'replacement');
await rag.remove('doc', { auth: 'a' });
assert.equal((await rag.retrieve('query', { auth: 'a' })).chunks.length, 0);
assert.equal((await rag.retrieve('query', { auth: 'b' })).chunks[0].text, 'tenant b');

let published = true;
const managed = createAiSearch({
  instanceIds: ['manuals'],
  authorizeSource: ({ instanceId, key }) =>
    published && instanceId === 'manuals' && key === 'guide/v1.md',
  binding: {
    search: async (input) => {
      assert.deepEqual(input.ai_search_options.instance_ids, ['manuals']);
      return {
        chunks: [
          {
            instance_id: 'manuals',
            id: 'chunk-1',
            type: 'text',
            score: 0.8,
            text: 'Managed passage',
            item: { key: 'guide/v1.md' },
          },
        ],
      };
    },
  },
});
const managedTool = managed.asTool();
assert.equal(
  (await asSchema(managedTool.inputSchema).validate({ query: 'q', instanceIds: ['other'] }))
    .success,
  false,
);
const managedResult = await managedTool.execute(
  { query: 'q' },
  { toolCallId: 'managed', messages: [], context: {} },
);
assert.equal(managedResult.context, '[source:1]\nManaged passage');
assert.deepEqual(managedResult.citations, [
  { id: '1', instanceId: 'manuals', key: 'guide/v1.md', chunkId: 'chunk-1' },
]);
published = false;
assert.deepEqual(await managed.retrieve('q'), { context: '', chunks: [], citations: [] });
