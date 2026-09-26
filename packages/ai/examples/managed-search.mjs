import assert from 'node:assert/strict';
import { createAiSearch } from '@velajs/ai/ai-search';

// A credential-free demonstration of application publication authority. Native
// AI Search ingestion is shown in docs/cloudflare-retrieval.md. This response
// intentionally contains staged, obsolete and cross-tenant candidates.
const candidates = ['v1', 'v2'].map((revision) => ({
  instance_id: 'manuals-a',
  id: `chunk-${revision}`,
  type: 'text',
  score: 0.9,
  text: `Guide ${revision}`,
  item: { key: `guide/${revision}.md` },
}));
candidates.push({ ...candidates[0], instance_id: 'manuals-b', text: 'Private B' });
const binding = { search: async () => ({ chunks: candidates }) };

// In production this record belongs in authoritative storage with atomic writes.
let publishedKey = 'guide/v1.md';
let allowed = true;
let deleted = false;
const identity = Object.freeze({ tenant: 'a' }); // supplied by verified authentication
const search = createAiSearch({
  binding,
  instanceIds: ['manuals-a'], // derived from the verified identity on the server
  authorizeSource: ({ instanceId, key }) =>
    identity.tenant === 'a' &&
    instanceId === 'manuals-a' &&
    !deleted &&
    allowed &&
    key === publishedKey,
});

const tool = search.asTool();
const query = () =>
  tool.execute({ query: 'guide' }, { toolCallId: 'example', messages: [], context: {} });
assert.equal((await query()).chunks[0].text, 'Guide v1');
publishedKey = 'guide/v2.md'; // atomically publish the new immutable key
assert.equal((await query()).chunks[0].text, 'Guide v2');
allowed = false; // revoke before requesting any index cleanup
assert.equal((await query()).chunks.length, 0);
allowed = true;
deleted = true; // tombstone before deleting the native item
assert.deepEqual(await query(), { context: '', chunks: [], citations: [] });
process.stdout.write('PASS: managed retrieval publication, ACL revocation and deletion\n');
