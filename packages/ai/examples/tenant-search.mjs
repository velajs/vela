import assert from 'node:assert/strict';
import { defineRag, memoryVectors } from '@velajs/ai/rag';

// Local demonstration only: replace this word-count embedder and memory store
// with your chosen AI SDK embedding model and a durable RagVectors adapter.
const vocabulary = ['refund', 'shipping', 'invoice'];
const docs = defineRag({
  name: 'support',
  vectors: memoryVectors(),
  embed: (text) => vocabulary.map((word) => text.toLowerCase().split(word).length - 1),
  embeddingModelVersion: 'word-count-v1',
  resolveNamespace: ({ auth, selector }) => {
    // auth is supplied by trusted server code, never copied from a request body.
    if (!auth || typeof auth !== 'object' || typeof auth.tenantId !== 'string') {
      throw new Error('Verified tenant identity required');
    }
    if (selector !== undefined && selector !== auth.tenantId) throw new Error('Tenant denied');
    return auth.tenantId;
  },
  rlsFilter: (auth) => {
    if (!auth || typeof auth !== 'object' || typeof auth.team !== 'string')
      throw new Error('Team denied');
    return { team: auth.team };
  },
});
const alice = { tenantId: 'shop-a', team: 'support' };
const bob = { tenantId: 'shop-b', team: 'support' };
await docs.sync([{ id: 'policy', text: 'Refund within 14 days.', metadata: { team: 'support' } }], {
  auth: alice,
});
await docs.sync([{ id: 'policy', text: 'Refund within 30 days.', metadata: { team: 'support' } }], {
  auth: bob,
});
const search = docs.asTool({ auth: alice });
const answer = await search.execute(
  { query: 'refund' },
  { toolCallId: 'demo', messages: [], context: {} },
);
assert.equal(answer.chunks[0].text, 'Refund within 14 days.');
await assert.rejects(
  docs.retrieve('refund', { auth: alice, namespace: 'shop-b' }),
  /Tenant denied/,
);
const update = [{ id: 'policy', text: 'Refund within 21 days.', metadata: { team: 'support' } }];
await docs.sync(update, { auth: alice });
assert.equal((await docs.sync(update, { auth: alice }))[0].unchanged, true);
const revised = await docs.retrieve('refund', { auth: alice });
assert.equal(revised.chunks[0].text, 'Refund within 21 days.');
process.stdout.write(
  `${revised.context}\nTenant isolation, request-bound tool and idempotent re-sync passed.\n`,
);
