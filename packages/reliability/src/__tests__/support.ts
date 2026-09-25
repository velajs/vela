import { afterEach, describe, expect, it } from 'vitest';
import {
  createIdempotency,
  createInbox,
  createOutbox,
  createScheduler,
  type ReliabilityStore,
  type Lease,
} from '../index';

export const scope = { tenantId: 'tenant-a', namespace: 'integration' };
export function parsePayload(value: unknown): { value: string } {
  if (!value || typeof value !== 'object' || !('value' in value) || typeof value.value !== 'string')
    throw new TypeError('Invalid payload');
  return { value: value.value };
}
export function claimed<T>(result: { kind: string; claim?: Lease<T> }): Lease<T> {
  if (!result.claim) throw new Error(`Expected claim, received ${result.kind}`);
  return result.claim;
}
/** Explicit test DDL mirrors the public schema helpers; never called by a constructor. */
export function ddl(table: string, dialect: 'sqlite' | 'pg'): string {
  const number = dialect === 'pg' ? 'BIGINT' : 'INTEGER';
  return `CREATE TABLE ${table} (
    tenant_id TEXT NOT NULL, namespace TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
    generation TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL,
    token TEXT, fence ${number} NOT NULL, revision ${number} NOT NULL, attempt ${number} NOT NULL,
    max_attempts ${number} NOT NULL, available_at ${number} NOT NULL, lease_until ${number},
    created_at ${number} NOT NULL, updated_at ${number} NOT NULL, retention_ms ${number} NOT NULL,
    expires_at ${number}, result TEXT, error TEXT,
    PRIMARY KEY(tenant_id, namespace, kind, id),
    CHECK(state IN ('pending','leased','completed','failed','cancelled')),
    CHECK(attempt >= 0 AND attempt <= max_attempts AND max_attempts BETWEEN 1 AND 1000)
  )`;
}
export interface Fixture<Tx = never> {
  store: ReliabilityStore<Tx>;
  other: ReliabilityStore<Tx>;
  shift(ms: number): Promise<void>;
  reopen(): Promise<ReliabilityStore<Tx>>;
  close(): Promise<void>;
}
export function contract<Tx>(name: string, setup: () => Promise<Fixture<Tx>>) {
  describe(name, () => {
    let cleanup: (() => Promise<void>) | undefined;
    const open = async () => {
      const fixture = await setup();
      cleanup = () => fixture.close();
      return fixture;
    };
    afterEach(async () => {
      await cleanup?.();
      cleanup = undefined;
    });
    // 16 contended claims serialize 110 emulated D1 statements: ~1.3s idle, past 5s on loaded CI.
    it('races independent claimers without losing fingerprint conflicts or tenant separation', async () => {
      const { store, other } = await open();
      const services = [store, other].map((s) =>
        createIdempotency({ store: s, parseResult: parsePayload }),
      );
      const results = await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
          services[i % 2]!.claim(scope, { key: 'request', fingerprint: 'one', leaseMs: 60_000 }),
        ),
      );
      expect(results.filter((r) => r.kind === 'claimed')).toHaveLength(1);
      expect(await services[0]!.claim(scope, { key: 'request', fingerprint: 'two' })).toEqual({
        kind: 'conflict',
      });
      expect(
        (
          await services[1]!.claim(
            { ...scope, tenantId: 'tenant-b' },
            { key: 'request', fingerprint: 'two' },
          )
        ).kind,
      ).toBe('claimed');
      expect(
        (
          await services[1]!.claim(
            { ...scope, namespace: 'another' },
            { key: 'request', fingerprint: 'two' },
          )
        ).kind,
      ).toBe('claimed');
      const lease = claimed(results.find((r) => r.kind === 'claimed')!);
      await services[0]!.complete(lease, { value: 'result' });
      expect(await services[1]!.claim(scope, { key: 'request', fingerprint: 'one' })).toEqual({
        kind: 'completed',
        value: { value: 'result' },
      });
      expect(await services[1]!.claim(scope, { key: 'request', fingerprint: 'two' })).toEqual({
        kind: 'conflict',
      });
    }, 20_000);
    it('fences expired workers after restart and persists retry state', async () => {
      const fixture = await open();
      const outbox = createOutbox({ store: fixture.store, parsePayload });
      await outbox.enqueue(scope, { id: 'message', payload: { value: 'first' }, leaseMs: 1000 });
      const old = (await outbox.claimDue(scope, { leaseMs: 1000 }))[0]!;
      expect(old.attempt).toBe(1);
      await fixture.shift(2000);
      const restarted = createOutbox({ store: await fixture.reopen(), parsePayload });
      const next = (await restarted.claimDue(scope))[0]!;
      expect(next.fence).toBeGreaterThan(old.fence);
      expect(next.attempt).toBe(2);
      await expect(outbox.complete(old)).rejects.toMatchObject({ code: 'LEASE_LOST' });
      await expect(outbox.renew(old)).rejects.toMatchObject({ code: 'LEASE_LOST' });
      await restarted.retry(next, { delayMs: 3000, error: 'temporary' });
      expect(await restarted.claimDue(scope)).toEqual([]);
      await fixture.shift(4000);
      const retried = (await restarted.claimDue(scope))[0]!;
      await restarted.complete(retried);
      expect(await outbox.claimDue(scope)).toEqual([]);
      expect((await outbox.get(scope, 'message'))?.state).toBe('completed');
    });
    it('deduplicates admission races and rejects changed content', async () => {
      const { store, other } = await open();
      const first = createOutbox({ store, parsePayload });
      const second = createOutbox({ store: other, parsePayload });
      const rows = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 ? first : second).enqueue(scope, { id: 'dedupe', payload: { value: 'same' } }),
        ),
      );
      expect(new Set(rows.map((row) => row.generation)).size).toBe(1);
      await expect(
        first.enqueue(scope, { id: 'dedupe', payload: { value: 'different' } }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      const all = await Promise.all([first.claimDue(scope), second.claimDue(scope)]);
      expect(all.flat()).toHaveLength(1);
    });
    it('expires replay retention without rerunning work and prevents old generations after pruning', async () => {
      const fixture = await open();
      const service = createIdempotency({ store: fixture.store, parseResult: parsePayload });
      const lease = claimed(
        await service.claim(scope, { key: 'retained', fingerprint: 'a', retentionMs: 1000 }),
      );
      await service.complete(lease, { value: 'saved' });
      await fixture.shift(2000);
      expect(await service.claim(scope, { key: 'retained', fingerprint: 'a' })).toEqual({
        kind: 'expired',
      });
      expect(await service.prune(scope)).toBe(1);
      const next = claimed(await service.claim(scope, { key: 'retained', fingerprint: 'new' }));
      expect(next.generation).not.toBe(lease.generation);
      await expect(service.complete(lease, { value: 'late' })).rejects.toMatchObject({
        code: 'LEASE_LOST',
      });
    });
    it('deduplicates inbox completion per consumer and checks payload equality', async () => {
      const { store } = await open();
      const inbox = createInbox({ store, parsePayload, consumer: 'processor' });
      const input = { messageId: 'message', fingerprint: 'body', payload: { value: 'body' } };
      const lease = claimed(await inbox.claim(scope, input));
      expect((await inbox.claim(scope, input)).kind).toBe('busy');
      expect((await inbox.claim(scope, { ...input, payload: { value: 'other' } })).kind).toBe(
        'conflict',
      );
      await inbox.complete(lease);
      expect((await inbox.claim(scope, input)).kind).toBe('completed');
      expect(
        (await createInbox({ store, parsePayload, consumer: 'other' }).claim(scope, input)).kind,
      ).toBe('claimed');
    });
    it('exhausts retry budgets including a crash on the final attempt', async () => {
      const fixture = await open();
      const service = createOutbox({ store: fixture.store, parsePayload });
      await service.enqueue(scope, { id: 'final', payload: { value: 'a' }, maxAttempts: 1 });
      const lease = (await service.claimDue(scope, { leaseMs: 1000 }))[0]!;
      expect(lease.attempt).toBe(1);
      await fixture.shift(2000);
      expect(await service.claimDue(scope)).toEqual([]);
      expect(await service.get(scope, 'final')).toMatchObject({
        state: 'failed',
        error: 'attempts-exhausted',
      });
      await service.enqueue(scope, { id: 'retry', payload: { value: 'b' }, maxAttempts: 1 });
      const retry = (await service.claimDue(scope))[0]!;
      expect(await service.retry(retry, { delayMs: 0 })).toMatchObject({
        state: 'failed',
        error: 'attempts-exhausted',
      });
    });
    it('cancels and reschedules with optimistic revisions and invalidates old claims', async () => {
      const fixture = await open();
      const scheduler = createScheduler({ store: fixture.store, parsePayload });
      const row = await scheduler.schedule(scope, {
        id: 'job',
        payload: { value: 'one-off' },
        dueAt: Date.now() + 60_000,
      });
      expect(await scheduler.claimDue(scope)).toEqual([]);
      const updated = await scheduler.reschedule(scope, {
        id: 'job',
        expectedGeneration: row.generation,
        expectedRevision: row.revision,
        dueAt: 0,
      });
      await expect(
        scheduler.cancel(scope, {
          id: 'job',
          expectedGeneration: row.generation,
          expectedRevision: row.revision,
        }),
      ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
      const claim = (await scheduler.claimDue(scope))[0]!;
      expect(claim).toBeDefined();
      const latest = (await scheduler.get(scope, 'job'))!;
      expect(latest.revision).toBeGreaterThan(updated.revision);
      await scheduler.cancel(scope, {
        id: 'job',
        expectedGeneration: latest.generation,
        expectedRevision: latest.revision,
      });
      await expect(scheduler.complete(claim)).rejects.toMatchObject({ code: 'LEASE_LOST' });
      expect(await scheduler.claimDue(scope)).toEqual([]);
    });
    it('rejects stale scheduler edits after retention pruning and id reuse', async () => {
      const fixture = await open();
      const scheduler = createScheduler({ store: fixture.store, parsePayload });
      const original = await scheduler.schedule(scope, {
        id: 'reused',
        payload: { value: 'old' },
        dueAt: 0,
        retentionMs: 1000,
      });
      const expected = {
        id: original.id,
        expectedGeneration: original.generation,
        expectedRevision: original.revision,
      };
      await scheduler.cancel(scope, expected);
      await fixture.shift(2000);
      expect(await scheduler.prune(scope)).toBe(1);
      const replacement = await scheduler.schedule(scope, {
        id: 'reused',
        payload: { value: 'new' },
        dueAt: 0,
      });
      expect(replacement.revision).toBe(original.revision);
      expect(replacement.generation).not.toBe(original.generation);
      await expect(scheduler.cancel(scope, expected)).rejects.toMatchObject({
        code: 'REVISION_CONFLICT',
      });
      await expect(
        scheduler.reschedule(scope, { ...expected, dueAt: Date.now() + 60_000 }),
      ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
      expect((await scheduler.claimDue(scope))[0]?.payload).toEqual({ value: 'new' });
    });
    it('rejects invalid payloads, lease limits and unscoped operations before admission', async () => {
      const { store } = await open();
      const service = createOutbox({ store, parsePayload, maxPayloadBytes: 64 });
      await expect(service.enqueue(scope, { id: 'bad', payload: { value: 5 } })).rejects.toThrow(
        'Invalid payload',
      );
      await expect(
        service.enqueue(scope, { id: 'large', payload: { value: 'x'.repeat(100) } }),
      ).rejects.toThrow('byte limit');
      await expect(
        service.enqueue({ ...scope, namespace: '' }, { id: 'bad', payload: { value: 'x' } }),
      ).rejects.toThrow('namespace');
      await expect(service.claimDue(scope, { leaseMs: Infinity })).rejects.toThrow('leaseMs');
      expect(await service.claimDue(scope)).toEqual([]);
    });
  });
}
