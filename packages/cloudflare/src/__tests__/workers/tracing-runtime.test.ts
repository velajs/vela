// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import * as cloudflareTest from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { VelaEnv } from '@velajs/vela';
import { createCloudflareWorker } from '../../cloudflare-factory';
import { TracingModule } from './tracing-fixture';

const pool: { SELF: Fetcher } = cloudflareTest;
const execution = {
  waitUntil(_promise: Promise<unknown>): void {},
  passThroughOnException(): void {},
  props: {},
};

function expected(probe: string) {
  return { before: probe, after: probe, outerTraced: false, innerTraced: false };
}

async function body(response: Response): Promise<unknown> {
  expect(response.status).toBe(200);
  return response.json();
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to reject');
}

// Real native API and KV/RPC calls, with sampling explicitly disabled in
// wrangler.test.toml. The pool does not expose exported span trees: these smoke
// tests do not assert parent IDs, sampling-enabled export or transport topology.
describe('native handler tracing under workerd', () => {
  it('awaits nested HTTP spans and binding calls with sampling disabled', async () => {
    expect(await body(await pool.SELF.fetch('https://worker.test/tracing'))).toEqual(
      expected('workerd-env'),
    );
  });

  it('awaits nested RPC work through both a service binding and an HTTP handler', async () => {
    const [direct, throughHttp] = await Promise.all([
      env.TRACING_RPC.read(),
      pool.SELF.fetch('https://worker.test/tracing/rpc').then(body),
    ]);
    expect(direct).toEqual(expected('workerd-env'));
    expect(throughHttp).toEqual(expected('workerd-env'));
  });

  it('preserves independent environments across concurrent awaited handler work', async () => {
    const worker = createCloudflareWorker(TracingModule);
    const a = { ...env, TRACING_PROBE: 'a' };
    const b = { ...env, TRACING_PROBE: 'b' };
    const read = (bindings: VelaEnv) =>
      worker.fetch(new Request('https://worker.test/tracing'), bindings, execution).then(body);
    expect(await Promise.all([read(a), read(b), read(a), read(b)])).toEqual([
      expected('a'),
      expected('b'),
      expected('a'),
      expected('b'),
    ]);
  });

  it('preserves HTTP and RPC failure handling and subsequent successful calls', async () => {
    const response = await pool.SELF.fetch('https://worker.test/tracing/fail');
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private tracing failure');
    expect(await rejection(env.TRACING_RPC.fail())).toMatchObject({
      status: 500,
      code: 'internal',
      message: 'Internal Server Error',
    });
    expect(await env.TRACING_RPC.read()).toEqual(expected('workerd-env'));
    expect(await body(await pool.SELF.fetch('https://worker.test/tracing'))).toEqual(
      expected('workerd-env'),
    );
  });
});
