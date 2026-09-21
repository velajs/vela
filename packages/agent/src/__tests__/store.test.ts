import { describe, expect, it } from 'vitest';

import { memoryThreadStore } from '../testing';

describe('memoryThreadStore idempotency + counter', () => {
  const identity = { ownerId: 'u1', tenantId: 'tenant-a' } as const;
  const scope = { threadKey: 't', agent: 'demo', ...identity } as const;
  it('dedups on messageKey, allocates a gap-free seq, and is ensureThread-idempotent', async () => {
    const store = memoryThreadStore();

    const created = await store.ensureThread({ ...scope, runKey: 'r1' });
    expect(created).toMatchObject({ created: true, thread: { threadKey: 't', agent: 'demo' } });

    const again = await store.ensureThread({ ...scope, runKey: 'r1' });
    expect(again).toMatchObject({ created: false, thread: { threadKey: 't', agent: 'demo' } });

    const first = await store.appendMessage({
      ...scope,
      messageKey: 'k1',
      role: 'user',
      content: 'hi',
    });
    expect(first).toEqual({ seq: 0, deduped: false });

    const second = await store.appendMessage({
      ...scope,
      messageKey: 'k2',
      role: 'assistant',
      content: 'yo',
    });
    expect(second).toEqual({ seq: 1, deduped: false });

    // A repeat of k1 with DIFFERENT content writes nothing and returns the original seq.
    const dup = await store.appendMessage({
      ...scope,
      messageKey: 'k1',
      role: 'user',
      content: 'DIFFERENT',
    });
    expect(dup).toEqual({ seq: 0, deduped: true });

    const rows = await store.listMessages(scope);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.seq)).toEqual([0, 1]);
    expect(rows[0]?.content).toBe('hi');
    expect(store.getThread(scope)?.messageCount).toBe(2);
  });

  it('patchThread updates the thread status', async () => {
    const store = memoryThreadStore();
    await store.ensureThread({ ...scope, runKey: 'r' });

    await store.patchThread({ ...scope, status: 'awaiting_input' });
    expect(store.getThread(scope)?.status).toBe('awaiting_input');

    await store.patchThread({ ...scope, status: 'idle' });
    expect(store.getThread(scope)?.status).toBe('idle');
  });

  it('stores error and usage metadata without sharing mutable references', async () => {
    const store = memoryThreadStore();
    await store.ensureThread({ ...scope, runKey: 'r' });
    const usage = { totalTokens: 3 };
    await store.patchThread({ ...scope, status: 'error', error: 'budget exhausted', usage });
    usage.totalTokens = 99;
    expect(store.getThread(scope)).toMatchObject({
      error: 'budget exhausted',
      usage: { totalTokens: 3 },
    });
    const thread = store.getThread(scope)!;
    thread.usage!.totalTokens = 10;
    expect(store.getThread(scope)?.usage?.totalTokens).toBe(3);
    await store.patchThread({ ...scope, status: 'running' });
    expect(store.getThread(scope)?.error).toBeUndefined();
  });

  it('isolates messages across threads', async () => {
    const store = memoryThreadStore();
    const a = { threadKey: 'a', agent: 'demo', ...identity } as const;
    const b = { threadKey: 'b', agent: 'demo', ...identity } as const;
    await store.ensureThread({ ...a, runKey: 'r' });
    await store.ensureThread({ ...b, runKey: 'r' });

    await store.appendMessage({
      ...a,
      messageKey: 'k',
      role: 'user',
      content: 'in-a',
    });

    expect(await store.listMessages(a)).toHaveLength(1);
    expect(await store.listMessages(b)).toHaveLength(0);
  });

  it('rejects reuse of a thread by a different owner, tenant, or agent', async () => {
    const store = memoryThreadStore();
    await store.ensureThread({
      threadKey: 'owned',
      agent: 'demo',
      runKey: 'r',
      ownerId: 'u1',
      tenantId: 'tenant-a',
    });
    await expect(
      store.ensureThread({
        threadKey: 'owned',
        agent: 'demo',
        runKey: 'r2',
        ownerId: 'u2',
        tenantId: 'tenant-a',
      }),
    ).rejects.toThrow(/scope/);

    await expect(
      store.listMessages({
        threadKey: 'owned',
        agent: 'demo',
        ownerId: 'u2',
        tenantId: 'tenant-a',
      }),
    ).rejects.toThrow(/scope/);
    await expect(
      store.patchThread({
        threadKey: 'owned',
        agent: 'demo',
        ownerId: 'u1',
        tenantId: 'tenant-b',
        status: 'idle',
      }),
    ).rejects.toThrow(/scope/);
  });

  it('rejects blank owner and tenant scopes before any operation', async () => {
    const store = memoryThreadStore();
    await expect(
      store.ensureThread({
        threadKey: 'blank',
        agent: 'demo',
        runKey: 'r',
        ownerId: '',
        tenantId: 'tenant-a',
      }),
    ).rejects.toThrow(/non-empty canonical/);
  });
});
