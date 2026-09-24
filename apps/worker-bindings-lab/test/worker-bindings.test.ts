import type { ExecutionContext } from 'hono';
import { ENV } from '@velajs/vela';
import type { MockWorkerEnv } from '../src/mock-env.js';
import { describe, expect, it } from 'vitest';
import { createWorkerBindingsLabApp } from '../src/app.js';
import { createExecutionContext, createMockWorkerEnv } from '../src/mock-env.js';

async function fetchJson(
  fetch: (request: Request, env: MockWorkerEnv, ctx: ExecutionContext) => Promise<Response>,
  path: string,
  env: MockWorkerEnv,
  ctx: ExecutionContext,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(
    new Request(`https://worker-bindings-lab.test${path}`, init),
    env,
    ctx,
  );
  return {
    status: response.status,
    body: await response.json(),
  };
}

describe('Worker bindings lab consumer project', () => {
  it('covers fetch routes using native Cloudflare bindings', async () => {
    const env = createMockWorkerEnv();
    const app = await createWorkerBindingsLabApp(env);
    const ctx = createExecutionContext();
    // The native environment is the framework ENV; no application token is involved.
    expect(app.get(ENV)).toBe(env);

    const envRes = await fetchJson(app.fetch, '/lab/env', env, ctx);
    expect(envRes.status).toBe(200);
    expect(envRes.body).toMatchObject({
      hasCache: true,
      keys: expect.arrayContaining([
        'AI',
        'ASSETS',
        'CACHE',
        'COUNTER_DO',
        'DB',
        'EVENT_LOG',
        'HYPERDRIVE',
        'JOB_QUEUE',
        'REPORT_QUEUE',
        'VECTORIZE',
      ]),
    });

    const writeKV = await fetchJson(app.fetch, '/lab/kv/greeting', env, ctx, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'hello worker' }),
    });
    expect(writeKV.status).toBe(201);
    expect(writeKV.body).toEqual({ key: 'greeting', value: 'hello worker' });

    const readKV = await fetchJson(app.fetch, '/lab/kv/greeting', env, ctx);
    expect(readKV.body).toEqual({ key: 'greeting', value: 'hello worker' });

    const d1 = await fetchJson(app.fetch, '/lab/d1/users/u1', env, ctx);
    expect(d1.body).toEqual({ user: { id: 'u1', name: 'Ada Harbor' } });

    const putAsset = await fetchJson(app.fetch, '/lab/r2/report.txt', env, ctx, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'asset-body' }),
    });
    expect(putAsset.body).toEqual({ key: 'report.txt', stored: true });

    const getAsset = await fetchJson(app.fetch, '/lab/r2/report.txt', env, ctx);
    expect(getAsset.body).toEqual({ key: 'report.txt', value: 'asset-body' });

    const queue = await fetchJson(app.fetch, '/lab/queue', env, ctx, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'sync-report', id: 7 }),
    });
    expect(queue.body).toEqual({ queued: true });
    expect(env.JOB_QUEUE._messages).toEqual([{ type: 'sync-report', id: 7 }]);

    const durableObject = await fetchJson(app.fetch, '/lab/durable-object/main', env, ctx);
    expect(durableObject.body).toEqual({ durableObject: true, name: 'main' });

    const ai = await fetchJson(app.fetch, '/lab/ai', env, ctx, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Summarize the dock schedule' }),
    });
    expect(ai.body).toMatchObject({
      model: '@cf/meta/llama-3.1-8b-instruct',
      response: 'lab-ai-response',
    });

    const vectorize = await fetchJson(app.fetch, '/lab/vectorize', env, ctx);
    expect(vectorize.body).toMatchObject({
      count: 1,
      matches: [expect.objectContaining({ id: 'doc-1', score: 0.98 })],
    });

    const hyperdrive = await fetchJson(app.fetch, '/lab/hyperdrive', env, ctx);
    expect(hyperdrive.body).toEqual({
      connectionString: 'postgres://lab:secret@db.example.test:5432/worker_lab',
      host: 'db.example.test',
      port: 5432,
      user: 'lab',
      database: 'worker_lab',
    });

    await app.close('binding-route-test-complete');
  });

  it('covers @Cron jobs on cron triggers and queue consumers', async () => {
    const env = createMockWorkerEnv();
    const app = await createWorkerBindingsLabApp(env);
    const ctx = createExecutionContext();

    await app.scheduled({ cron: '*/15 * * * *', scheduledTime: 1_000 }, env, ctx);
    await app.scheduled({ cron: '0 * * * *', scheduledTime: 2_000 }, env, ctx);
    await app.queue(
      {
        queue: 'JOB_QUEUE',
        messages: [{ body: { id: 'job-1' } }, { body: { id: 'job-2' } }],
      },
      env,
      ctx,
    );

    expect(env.EVENT_LOG).toEqual(['quarter-hourly:1000', 'hourly:2000', 'queue:2']);

    await app.close('event-handler-test-complete');
  });

  it('sends and processes typed jobs through QueueModule and cloudflareQueues()', async () => {
    const env = createMockWorkerEnv();
    const app = await createWorkerBindingsLabApp(env);
    const ctx = createExecutionContext();

    const sent = await fetchJson(app.fetch, '/lab/reports', env, ctx, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 7 }),
    });
    expect(sent.body).toEqual({ queued: true });
    // The driver sent a job envelope through the REPORT_QUEUE producer binding.
    const [job] = env.REPORT_QUEUE._messages;
    expect(job).toMatchObject({ queue: 'reports', name: 'sync-report', data: { id: 7 } });

    // Native delivery routes the envelope by its logical queue to the processor.
    const acked: string[] = [];
    const message = {
      id: 'report-message',
      timestamp: new Date(),
      attempts: 1,
      body: job,
      ack: () => acked.push('report-message'),
      retry: () => undefined,
    };
    await app.queue({ queue: 'reports-production', messages: [message] }, env, ctx);
    expect(env.EVENT_LOG).toEqual(['report:7']);
    expect(acked).toEqual(['report-message']);

    await app.close('typed-queue-test-complete');
  });

  it('exports a Worker-shaped default object', async () => {
    const { default: worker } = await import('../src/worker.js');
    const env = createMockWorkerEnv();
    const ctx = createExecutionContext();

    const envRes = await fetchJson(worker.fetch, '/lab/env', env, ctx);
    expect(envRes.status).toBe(200);
    expect(envRes.body).toMatchObject({ hasCache: true });

    await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: 3_000 }, env, ctx);
    const message: Message<unknown> = {
      id: 'message-1',
      timestamp: new Date(),
      body: { id: 'worker-default' },
      attempts: 1,
      retry: () => undefined,
      ack: () => undefined,
    };
    const batch: MessageBatch<unknown> = {
      queue: 'JOB_QUEUE',
      messages: [message],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: () => undefined,
      ackAll: () => undefined,
    };
    await worker.queue(batch, env, ctx);

    expect(env.EVENT_LOG).toEqual(['quarter-hourly:3000', 'queue:1']);
  });
});
