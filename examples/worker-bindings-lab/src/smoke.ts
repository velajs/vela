import { createWorkerBindingsLabApp } from './app.js';
import { createExecutionContext, createMockWorkerEnv } from './mock-env.js';

const app = await createWorkerBindingsLabApp();
const env = createMockWorkerEnv();
const ctx = createExecutionContext();

async function json(path: string, init?: RequestInit): Promise<unknown> {
  const response = await app.fetch(new Request(`https://worker-bindings-lab.test${path}`, init), env, ctx);
  return { status: response.status, body: await response.json() };
}

console.log(await json('/lab/env'));
console.log(
  await json('/lab/kv/sample', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'stored-from-smoke' }),
  }),
);
console.log(await json('/lab/kv/sample'));
console.log(await json('/lab/hyperdrive'));

await app.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now() }, env, ctx);
await app.queue({ queue: 'JOB_QUEUE', messages: [{ body: { id: 'smoke-job' } }] }, env, ctx);
console.log({ eventLog: env.EVENT_LOG });

await app.close('smoke');
