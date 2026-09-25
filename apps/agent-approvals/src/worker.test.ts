// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import * as test from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import type { AgentMessage } from '@velajs/agent';

const pool: {
  SELF: Fetcher;
  introspectWorkflowInstance(
    binding: Workflow,
    id: string,
  ): Promise<{
    waitForStatus(status: string): Promise<void>;
    getOutput(): Promise<unknown>;
    dispose(): Promise<void>;
  }>;
} = test;
const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };

it('authenticates ingress, resumes a persisted approval and signs tool dispatch through the DI host', async () => {
  expect((await pool.SELF.fetch('https://example.test/runs', { method: 'POST' })).status).toBe(401);
  expect(
    (await pool.SELF.fetch('https://example.test/internal/acknowledge', { method: 'POST' })).status,
  ).toBe(403);
  const threadKey = crypto.randomUUID();
  const response = await pool.SELF.fetch('https://example.test/runs', {
    method: 'POST',
    headers,
    body: JSON.stringify({ threadKey, runKey: 'review', input: 'Please review' }),
  });
  expect(response.status).toBe(201);
  const { id } = await response.json<{ id: string }>();
  const inspector = await pool.introspectWorkflowInstance(env.REVIEW, id);
  try {
    const instance = await env.REVIEW.get(id);
    using subscription = await instance.subscribe({ filter: ['wait_started'] });
    await subscription.next();
    const stored = await pool.SELF.fetch(`https://example.test/threads/${threadKey}`, { headers });
    const messages = await stored.json<AgentMessage[]>();
    const nonce = messages.find((message) => message.approval)?.approval?.nonce;
    expect(nonce).toEqual(expect.any(String));
    const approved = await pool.SELF.fetch(`https://example.test/runs/${id}/approve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ threadKey, nonce, decision: 'approve' }),
    });
    expect(approved.status).toBe(204);
    await inspector.waitForStatus('complete');
    expect(await inspector.getOutput()).toMatchObject({
      stopped: 'final',
      text: 'Review complete',
    });
    const completed = await (
      await pool.SELF.fetch(`https://example.test/threads/${threadKey}`, { headers })
    ).json<AgentMessage[]>();
    expect(completed.find((message) => message.status === 'approved')?.content).toContain(
      'acknowledged',
    );
    expect((await pool.SELF.fetch(`https://example.test/runs/${id}/events`)).status).toBe(401);
    const events = await pool.SELF.fetch(`https://example.test/runs/${id}/events`, { headers });
    expect(events.headers.get('content-type')).toBe('text/event-stream');
    await events.body?.cancel();
  } finally {
    await inspector.dispose();
  }
}, 15_000);
