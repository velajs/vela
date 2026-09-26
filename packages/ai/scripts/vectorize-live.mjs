/* eslint-disable no-await-in-loop -- Bounded polling observes successive remote states. */
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { defineRag, memoryPublications } from '../dist/rag/index.js';
import { vectorizeVectors } from '../dist/vectorize/index.js';

if (process.env.VELA_VECTORIZE_LIVE !== '1')
  throw new Error(
    'Set VELA_VECTORIZE_LIVE=1 with explicitly supplied pre-existing synthetic resources; no resources are provisioned.',
  );
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const index = process.env.VELA_VECTORIZE_INDEX;
const metric = process.env.VELA_VECTORIZE_METRIC;
if (
  !/^[a-f0-9]{32}$/.test(account ?? '') ||
  !token ||
  !/^vela-synthetic-[a-z0-9-]{1,48}$/.test(index ?? '') ||
  !['cosine', 'euclidean', 'dot-product'].includes(metric)
)
  throw new Error(
    'Supply account ID, API token, VELA_VECTORIZE_INDEX starting vela-synthetic-, and its exact VELA_VECTORIZE_METRIC.',
  );
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/vectorize/v2/indexes/${index}`;
const runId = crypto.randomUUID();
const cleanupIds = new Set();
let deadline = Date.now() + 120_000;
const request = async (path, body, ndjson = false) => {
  const response = await fetch(`${base}/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': ndjson ? 'application/x-ndjson' : 'application/json',
    },
    ...(body === undefined ? {} : { body: ndjson ? body : JSON.stringify(body) }),
    signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now()))),
  });
  const data = await response.json();
  if (!response.ok || data.success !== true)
    throw new Error(`Vectorize ${path} failed (${response.status})`);
  return data.result;
};
const binding = {
  async upsert(records) {
    // Record IDs before submission, including an ambiguous timeout.
    records.forEach((record) => cleanupIds.add(record.id));
    const result = await request(
      'upsert',
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
      true,
    );
    return { mutationId: result.mutationId };
  },
  async deleteByIds(ids) {
    const result = await request('delete_by_ids', { ids });
    return { mutationId: result.mutationId };
  },
  getByIds: (ids) => request('get_by_ids', { ids }),
  query: (vector, options) => request('query', { vector, ...options }),
  async describe() {
    const result = await request('info');
    return {
      dimensions: result.dimensions,
      vectorCount: result.vectorCount,
      processedUpToMutation: result.processedUpToMutation,
      processedUpToDatetime: result.processedUpToDatetime,
    };
  },
};
const info = await binding.describe();
assert.ok(Number.isInteger(info.dimensions) && info.dimensions > 0 && info.dimensions <= 1536);
const embedding = Array.from({ length: info.dimensions }, (_, i) => (i === 0 ? 1 : 0));
const vectors = vectorizeVectors(binding, { dimensions: info.dimensions, metric });
const publications = memoryPublications();
const rag = defineRag({
  vectors,
  publications,
  embed: () => embedding,
  resolveNamespace: ({ auth }) => auth,
  rlsFilter: () => ({ allowed: true }),
});
const scope = { auth: `live-${runId}` };
const poll = async (label, predicate) => {
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await setTimeout(Math.min(1000, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`Bounded observation timed out: ${label}`);
};
try {
  const [first] = await rag.sync(
    [{ id: 'synthetic-document', text: 'first synthetic passage', metadata: { allowed: true } }],
    scope,
  );
  assert.equal(first.indexing.status, 'accepted');
  // Observe query results directly; neither describe nor getByIds gates readiness.
  await poll(
    'initial query visibility',
    async () => (await rag.retrieve('q', scope)).chunks[0]?.text === 'first synthetic passage',
  );
  assert.equal((await rag.retrieve('q', { auth: `other-${runId}` })).chunks.length, 0);
  const [replacement] = await rag.sync(
    [
      {
        id: 'synthetic-document',
        text: 'replacement synthetic passage',
        metadata: { allowed: false },
        expectedRevision: first.revision,
      },
    ],
    scope,
  );
  assert.equal((await rag.retrieve('q', scope)).chunks.length, 0);
  const tombstone = await rag.remove('synthetic-document', {
    ...scope,
    expectedRevision: replacement.revision,
  });
  assert.equal((await rag.retrieve('q', scope)).chunks.length, 0);
  await rag.reconcile('synthetic-document', { ...scope, revision: tombstone.revision });
  process.stdout.write(
    `PASS: live initial query observed, tenant isolation, ACL replacement and deletion (${runId}); no global visibility guarantee inferred.\n`,
  );
} finally {
  // An independent 60-second cleanup budget. Only IDs recorded in this run are deleted.
  deadline = Date.now() + 60_000;
  const ids = [...cleanupIds];
  if (ids.length) {
    await binding.deleteByIds(ids);
    await poll('by-ID cleanup observation', async () => (await binding.getByIds(ids)).length === 0);
    process.stdout.write(
      'Cleanup submitted and by-ID absence observed; stale query replicas or late writes are not ruled out.\n',
    );
  }
}
