import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createIdempotency, createOutbox, createInbox, createScheduler } from '@velajs/reliability';
import {
  captureHttpResult,
  parseHttpResult,
  replayHttpResult,
  fingerprintRequest,
} from '@velajs/reliability/http';
import { createMemoryReliabilityStore } from '@velajs/reliability/testing';

const require = createRequire(import.meta.url);
for (const peer of ['@velajs/vela', '@velajs/crud', '@velajs/crud-drizzle', 'drizzle-orm'])
  assert.throws(() => require.resolve(peer), { code: 'MODULE_NOT_FOUND' });
let now = 1_000;
const store = createMemoryReliabilityStore({ now: () => now });
const scope = { tenantId: 'tenant-a', namespace: 'consumer' };
const service = createIdempotency({ store, parseResult: parseHttpResult });
const input = { key: 'request', fingerprint: 'body' };
const results = await Promise.all(Array.from({ length: 8 }, () => service.claim(scope, input)));
assert.equal(results.filter((result) => result.kind === 'claimed').length, 1);
assert.equal((await service.claim(scope, { ...input, fingerprint: 'other' })).kind, 'conflict');
const captured = await captureHttpResult(
  new Response(new Uint8Array([0, 128, 255]), {
    status: 201,
    headers: { 'content-type': 'application/octet-stream', 'set-cookie': 'private=1' },
  }),
);
await service.complete(results.find((result) => result.kind === 'claimed').claim, captured);
const replay = await service.claim(scope, input);
assert.equal(replay.kind, 'completed');
const response = replayHttpResult(replay.value);
assert.equal(response.status, 201);
assert.equal(response.headers.get('set-cookie'), null);
assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 128, 255]));
await assert.rejects(captureHttpResult(new Response('oversized'), { maxBodyBytes: 2 }), /limit/);
const request = new Request('https://example.test/items', { method: 'POST', body: 'value' });
const digest = await fingerprintRequest(request, { operation: 'create', principal: 'verified' });
assert.equal(
  digest,
  await fingerprintRequest(request, { operation: 'create', principal: 'verified' }),
);
assert.equal(await request.text(), 'value');
const parsePayload = (value) => {
  if (typeof value !== 'string') throw new TypeError('Expected text payload');
  return value;
};
const outbox = createOutbox({ store, parsePayload });
await outbox.enqueue(scope, { id: 'message', payload: 'body' });
const [stale] = await outbox.claimDue(scope, { leaseMs: 1_000 });
now += 2_000;
const [current] = await outbox.claimDue(scope);
assert.notEqual(current.token, stale.token);
await assert.rejects(outbox.complete(stale), { code: 'LEASE_LOST' });
await outbox.acknowledge(current);
assert.deepEqual(await outbox.claimDue(scope), []);
const inbox = createInbox({ store, parsePayload, consumer: 'processor' });
const delivery = { messageId: 'message', fingerprint: 'body', payload: 'body' };
const claim = await inbox.claim(scope, delivery);
await inbox.complete(claim.claim);
assert.equal((await inbox.claim(scope, delivery)).kind, 'completed');
const scheduler = createScheduler({ store, parsePayload });
const job = await scheduler.schedule(scope, { id: 'job', payload: 'job', dueAt: now + 1_000 });
const edited = await scheduler.reschedule(scope, {
  id: 'job',
  expectedGeneration: job.generation,
  expectedRevision: job.revision,
  dueAt: now,
});
await assert.rejects(
  scheduler.cancel(scope, {
    id: 'job',
    expectedGeneration: job.generation,
    expectedRevision: job.revision,
  }),
  {
    code: 'REVISION_CONFLICT',
  },
);
await scheduler.cancel(scope, {
  id: 'job',
  expectedGeneration: edited.generation,
  expectedRevision: edited.revision,
});
assert.deepEqual(await scheduler.claimDue(scope), []);
