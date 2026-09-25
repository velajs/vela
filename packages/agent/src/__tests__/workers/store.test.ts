/* eslint-disable no-await-in-loop -- Sequential probes verify each rejected mutation leaves shared thread state intact. */
// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import * as test from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { durableAgentThreadStore } from '../../cloudflare/index';
import type { AgentApprovalEvent, AgentRunResult, AgentThreadScope } from '../../index';

const pool: { abortAllDurableObjects(): Promise<void> } = test;
const scope = (): AgentThreadScope => ({
  threadKey: crypto.randomUUID(),
  agent: 'reviewer',
  ownerId: 'operator',
  tenantId: 'tenant-a',
});
const result: AgentRunResult = { stopped: 'final', text: 'done', turns: 1 };
const store = () => durableAgentThreadStore(env.THREADS);
const claim = (s: AgentThreadScope) => ({
  ...s,
  runKey: 'run',
  instanceId: 'instance',
  inputDigest: 'a'.repeat(64),
});

it('serializes competing claims, keeps gap-free deduped messages, and survives object restart', async () => {
  const s = scope();
  await store().ensureThread({ ...s, runKey: 'run' });
  const competitors = await Promise.allSettled([
    store().claimRun(claim(s)),
    store().claimRun({ ...claim(s), instanceId: 'other' }),
  ]);
  expect(competitors.map((outcome) => outcome.status).toSorted()).toEqual([
    'fulfilled',
    'rejected',
  ]);
  const owner = competitors[0]?.status === 'fulfilled' ? 'instance' : 'other';
  const append = (messageKey: string) =>
    store().appendMessage({ ...s, messageKey, role: 'user', content: messageKey });
  const writes = await Promise.all(
    Array.from({ length: 20 }, (_, index) => append(`message-${index % 10}`)),
  );
  expect(writes.filter((write) => write.deduped)).toHaveLength(10);
  expect((await store().listMessages(s)).map((row) => row.seq)).toEqual(
    Array.from({ length: 10 }, (_, i) => i),
  );
  await pool.abortAllDurableObjects();
  expect(await store().listMessages(s)).toHaveLength(10);
  await expect(store().claimRun({ ...claim(s), inputDigest: 'b'.repeat(64) })).rejects.toThrow(
    'different input',
  );
  await expect(store().claimRun({ ...claim(s), runKey: 'competing' })).rejects.toThrow(
    'active workflow',
  );
  await expect(
    store().finishRun({ ...s, runKey: 'run', instanceId: 'intruder', result }),
  ).rejects.toThrow('another instance');
  await store().finishRun({ ...s, runKey: 'run', instanceId: owner, result });
  expect(await store().claimRun({ ...claim(s), instanceId: 'duplicate-delivery' })).toEqual(result);
  await expect(
    store().finishRun({
      ...s,
      runKey: 'run',
      instanceId: owner,
      result: { ...result, text: 'changed' },
    }),
  ).rejects.toThrow('cannot change');
  await store().claimRun({ ...claim(s), runKey: 'next-run' });
  await store().finishRun({ ...s, runKey: 'run', instanceId: owner, result });
  await expect(store().claimRun({ ...claim(s), runKey: 'third-run' })).rejects.toThrow(
    'active workflow',
  );
});

it('checks every scope field for every operation without leaking or mutating rows', async () => {
  const s = scope();
  await store().ensureThread({ ...s, runKey: 'run' });
  await store().claimRun(claim(s));
  await store().appendMessage({ ...s, messageKey: 'first', role: 'user', content: 'private' });
  for (const field of ['ownerId', 'tenantId', 'agent', 'threadKey'] as const) {
    const forged = { ...s, [field]: 'someone-else' };
    // Direct stub calls also enforce scope even if a caller skips name routing.
    const stub = env.THREADS.get(env.THREADS.idFromName(s.threadKey));
    await expect(Promise.resolve(stub.ensureThread({ ...forged, runKey: 'run' }))).rejects.toThrow(
      'scope',
    );
    await expect(Promise.resolve(stub.claimRun(claim(forged)))).rejects.toThrow('scope');
    await expect(
      Promise.resolve(stub.finishRun({ ...forged, runKey: 'run', instanceId: 'instance', result })),
    ).rejects.toThrow('scope');
    await expect(Promise.resolve(stub.listMessages(forged))).rejects.toThrow('scope');
    await expect(
      Promise.resolve(
        stub.appendMessage({ ...forged, messageKey: 'forged', role: 'user', content: 'forged' }),
      ),
    ).rejects.toThrow('scope');
    await expect(Promise.resolve(stub.patchThread({ ...forged, status: 'idle' }))).rejects.toThrow(
      'scope',
    );
  }
  expect(await store().listMessages(s)).toHaveLength(1);
  await expect(store().listMessages({ ...s, ownerId: ' operator ' })).rejects.toThrow();
  const other = durableAgentThreadStore(env.OTHER_THREADS);
  await other.ensureThread({ ...s, ownerId: 'other', runKey: 'run' });
  expect(await other.listMessages({ ...s, ownerId: 'other' })).toEqual([]);
});

it('rolls back failed writes and retains an immutable authenticated approval verdict', async () => {
  const s = scope();
  await store().ensureThread({ ...s, runKey: 'run' });
  await store().claimRun(claim(s));
  const challenge = {
    instanceId: 'instance',
    threadKey: s.threadKey,
    runKey: 'run',
    toolCallId: 'call',
    turn: 0,
    toolName: 'acknowledge',
    inputDigest: 'a'.repeat(64),
    nonce: crypto.randomUUID(),
    expiresAt: Date.now() + 60_000,
    ownerId: s.ownerId,
    tenantId: s.tenantId,
  };
  await store().appendMessage({
    ...s,
    messageKey: 'approval',
    role: 'tool',
    content: 'pending',
    status: 'awaiting_approval',
    approval: challenge,
  });
  // A second message with the same challenge violates the SQL unique key; the
  // transaction must allocate neither a message nor a sequence number.
  await expect(
    store().appendMessage({
      ...s,
      messageKey: 'another',
      role: 'tool',
      content: 'pending',
      approval: challenge,
    }),
  ).rejects.toThrow();
  const decision: AgentApprovalEvent = { ...challenge, decision: 'approve', approverId: 'manager' };
  expect(await store().verifyApproval(s, decision)).toBe(false);
  await store().recordApproval(s, decision);
  await pool.abortAllDurableObjects();
  await store().recordApproval(s, decision);
  expect(await store().verifyApproval(s, decision)).toBe(true);
  expect(await store().verifyApproval(s, { ...decision, approverId: 'forged' })).toBe(false);
  await expect(store().recordApproval(s, { ...decision, decision: 'reject' })).rejects.toThrow(
    'cannot change',
  );
  for (const op of ['recordApproval', 'verifyApproval'] as const) {
    await expect(store()[op]({ ...s, ownerId: 'forged' }, decision)).rejects.toThrow('scope');
  }
  expect(
    await store().appendMessage({ ...s, messageKey: 'last', role: 'assistant', content: 'ok' }),
  ).toEqual({ seq: 1, deduped: false });
});

it('rejects new approval decisions after expiry or run completion', async () => {
  const s = scope();
  await store().ensureThread({ ...s, runKey: 'run' });
  await store().claimRun(claim(s));
  const challenge = {
    instanceId: 'instance',
    threadKey: s.threadKey,
    runKey: 'run',
    toolCallId: 'call',
    turn: 0,
    toolName: 'acknowledge',
    inputDigest: 'a'.repeat(64),
    nonce: 'expired',
    expiresAt: Date.now() - 1,
    ownerId: s.ownerId,
    tenantId: s.tenantId,
  };
  await store().appendMessage({
    ...s,
    messageKey: 'expired',
    role: 'tool',
    content: 'pending',
    approval: challenge,
  });
  await expect(
    store().recordApproval(s, { ...challenge, decision: 'approve', approverId: 'manager' }),
  ).rejects.toThrow('expired');
  const active = { ...challenge, nonce: 'active', expiresAt: Date.now() + 60_000 };
  await store().appendMessage({
    ...s,
    messageKey: 'active',
    role: 'tool',
    content: 'pending',
    approval: active,
  });
  await store().finishRun({ ...s, runKey: 'run', instanceId: 'instance', result });
  await expect(
    store().recordApproval(s, { ...active, decision: 'approve', approverId: 'manager' }),
  ).rejects.toThrow('inactive');
});
