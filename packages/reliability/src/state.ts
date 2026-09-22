import type { WorkRecord, Lease, Transition } from './types';
import { integer, MAX_DURATION, MAX_TIME, text } from './validation';
export function due(record: WorkRecord, now: number): boolean {
  return (
    (record.state === 'pending' || record.state === 'leased') &&
    record.availableAt <= now &&
    (record.leaseUntil === null || record.leaseUntil <= now)
  );
}
export function owned(record: WorkRecord, claim: Lease, now: number): boolean {
  return (
    record.tenantId === claim.tenantId &&
    record.namespace === claim.namespace &&
    record.kind === claim.kind &&
    record.id === claim.id &&
    record.generation === claim.generation &&
    record.token === claim.token &&
    record.fence === claim.fence &&
    record.state === 'leased' &&
    record.leaseUntil !== null &&
    record.leaseUntil > now
  );
}
export function transitionValues(
  record: WorkRecord,
  change: Transition,
  now: number,
): Partial<WorkRecord> {
  integer(record.revision + 1, 'revision', 1, Number.MAX_SAFE_INTEGER);
  const expiresAt = integer(now + record.retentionMs, 'retention expiry', 0, MAX_TIME);
  const base = { updatedAt: now, revision: record.revision + 1 };
  if (change.state === 'leased')
    return {
      ...base,
      leaseUntil: integer(now + integer(change.leaseMs, 'leaseMs', 1, 3_600_000), 'lease expiry'),
    };
  if (change.state === 'pending' && record.attempt < record.maxAttempts)
    return {
      ...base,
      state: 'pending',
      token: null,
      leaseUntil: null,
      availableAt: integer(now + integer(change.delayMs, 'delayMs', 0, MAX_DURATION), 'retry time'),
      error: change.error ?? null,
    };
  if (change.state === 'completed')
    return {
      ...base,
      state: 'completed',
      token: null,
      leaseUntil: null,
      expiresAt,
      result: change.result ?? 'null',
      error: null,
    };
  return {
    ...base,
    state: 'failed',
    token: null,
    leaseUntil: null,
    expiresAt,
    error: text(
      change.state === 'pending' ? 'attempts-exhausted' : (change.error ?? 'failed'),
      'error',
      512,
    ),
  };
}
