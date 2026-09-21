import assert from 'node:assert/strict';
import * as core from '@velajs/ai';
import * as ragExports from '@velajs/ai/rag';
import { asSchema } from 'ai';
import { MockLanguageModelV4, MockEmbeddingModelV4 } from 'ai/test';

for (const name of ['createAi', 'generateText', 'streamText', 'embed', 'tool', 'jsonSchema'])
  assert.equal(typeof core[name], 'function');
for (const name of [
  'defineRag',
  'memoryVectors',
  'fixedWindowChunks',
  'contentHash',
  'mapWithConcurrency',
])
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
