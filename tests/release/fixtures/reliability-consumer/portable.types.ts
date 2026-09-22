import {
  createIdempotency,
  createOutbox,
  createScheduler,
  type ReliabilityScope,
} from '@velajs/reliability';
import { createMemoryReliabilityStore } from '@velajs/reliability/testing';
import { parseHttpResult, replayHttpResult } from '@velajs/reliability/http';

const store = createMemoryReliabilityStore();
const scope: ReliabilityScope = { tenantId: 'verified', namespace: 'example' };
const idempotency = createIdempotency({ store, parseResult: parseHttpResult });
const result = await idempotency.claim(scope, { key: 'request', fingerprint: 'digest' });
if (result.kind === 'completed') replayHttpResult(result.value);
if (result.kind === 'claimed')
  await idempotency.complete(result.claim, { status: 204, headers: [], body: '' });
const parsePayload = (value: unknown) => {
  if (typeof value !== 'string') throw new TypeError('Expected text');
  return value;
};
const outbox = createOutbox({ store, parsePayload });
const claims = await outbox.claimDue(scope);
const payload: string | undefined = claims[0]?.payload;
void payload;
const scheduler = createScheduler({ store, parsePayload });
await scheduler.schedule(scope, { id: 'job', payload: 'value', dueAt: 1 });
// @ts-expect-error Tenant ownership is mandatory.
await outbox.enqueue({ namespace: 'example' }, { id: 'event', payload: 'value' });
// @ts-expect-error The reference adapter does not accept arbitrary transaction tokens.
await outbox.claimDue(scope, {}, { transaction: {} });
