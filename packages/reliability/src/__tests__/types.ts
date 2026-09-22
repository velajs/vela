import { expectTypeOf } from 'vitest';
import {
  createInbox,
  createOutbox,
  createIdempotency,
  type ReliabilityStore,
  type Lease,
} from '../index';

interface Transaction {
  readonly transactionBrand: unique symbol;
}
declare const store: ReliabilityStore<Transaction>;
declare const transaction: Transaction;
declare const other: { readonly different: true };
const scope = { tenantId: 'tenant', namespace: 'feature' };
const parse = (value: unknown): { id: string } => {
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string')
    throw new TypeError('Expected id');
  return { id: value.id };
};
async function types() {
  const outbox = createOutbox({ store, parsePayload: parse });
  await outbox.enqueue(scope, { id: 'event', payload: { id: 'record' } }, { transaction });
  const leases = await outbox.claimDue(scope);
  expectTypeOf(leases).toEqualTypeOf<Lease<{ id: string }>[]>();
  // @ts-expect-error Transaction ownership tokens retain the adapter's type.
  await outbox.enqueue(scope, { id: 'event', payload: {} }, { transaction: other });
  const inbox = createInbox({ store, parsePayload: parse, consumer: 'consumer' });
  const result = await inbox.claim(scope, {
    messageId: 'message',
    fingerprint: 'body',
    payload: { id: 'record' },
  });
  if (result.kind === 'claimed') expectTypeOf(result.claim.payload).toEqualTypeOf<{ id: string }>();
  const idem = createIdempotency({ store, parseResult: parse });
  const replay = await idem.claim(scope, { key: 'key', fingerprint: 'body' });
  if (replay.kind === 'completed') expectTypeOf(replay.value).toEqualTypeOf<{ id: string }>();
  // @ts-expect-error Every operation requires an explicit tenant namespace.
  await idem.claim({ namespace: 'feature' }, { key: 'key', fingerprint: 'body' });
}
void types;
