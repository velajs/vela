// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import * as cloudflareTest from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { isEntrypointError } from '../../index';

/** The `cloudflare:test` helpers these specs drive. */
interface WorkersTestPool {
  SELF: Fetcher;
}
const pool: WorkersTestPool = cloudflareTest;

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to reject');
}

/** Every own property of an error delivered across the RPC boundary, as text. */
function everything(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error);
  return Object.getOwnPropertyNames(error)
    .map((name) => `${name}=${String(Reflect.get(error, name))}`)
    .join('\n');
}

describe('VelaEntrypoint under workerd', () => {
  it('serves typed RPC through a service binding, in the Worker application', async () => {
    expectTypeOf(env.BILLING.charge).parameters.toEqualTypeOf<[customer: string, cents: number]>();
    // @ts-expect-error a method the rpc list leaves out is not on the binding
    void env.BILLING.audit;

    const first = await env.BILLING.charge('customer-1', 500);
    const second = await env.BILLING.charge('customer-2', 700);
    // The binding's props reach the host as ENTRYPOINT_PROPS.
    expect(first).toMatchObject({ tenant: 'acme' });
    // Each call builds its own request-scoped providers.
    expect(first.call).not.toBe(second.call);
    // The Worker's fetch handler sees the same singletons: one application per environment.
    const response = await pool.SELF.fetch('https://worker.test/ledger');
    const ledger: { charges: string[] } = await response.json();
    expect(ledger.charges).toEqual(expect.arrayContaining(['customer-1:500', 'customer-2:700']));
  });

  it('runs guards with the caller props of a ctx.exports loopback stub', async () => {
    const other = exports.Billing({ props: { tenant: 'other' } });
    const error = await rejection(other.charge('customer-3', 1));
    expect(isEntrypointError(error)).toBe(true);
    expect(error).toMatchObject({ status: 403, code: 'forbidden', message: 'Forbidden' });
    expect(
      await exports.Billing({ props: { tenant: 'acme' } }).charge('customer-4', 1),
    ).toMatchObject({ tenant: 'acme' });
  });

  it('reports a failure and redacts it across the RPC boundary', async () => {
    const error = await rejection(env.BILLING.leak());
    expect(isEntrypointError(error)).toBe(true);
    expect(error).toMatchObject({
      status: 500,
      code: 'internal',
      message: 'Internal Server Error',
    });
    const delivered = everything(error);
    expect(delivered).not.toContain('secret');
    expect(delivered).not.toContain('entry.ts');
    expect(delivered).not.toContain('host-invoker');
    expect(await env.BILLING.reported()).toContain('secret billing detail');

    const denied = await rejection(env.BILLING.denied());
    expect(denied).toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('exposes only the listed methods over RPC', async () => {
    for (const method of ['audit', 'fetch', 'onModuleInit', 'dispose']) {
      const call: unknown = Reflect.get(env.BILLING, method);
      if (typeof call !== 'function') throw new Error(`BILLING.${method} is not callable`);
      // eslint-disable-next-line no-await-in-loop -- One call at a time.
      const error = await rejection(
        Promise.resolve(
          Reflect.apply(call, env.BILLING, method === 'fetch' ? ['https://x.test/'] : []),
        ),
      );
      // workerd: "does not implement"; the Vitest pool's entrypoint wrapper: "to define".
      expect(String(error)).toMatch(/does not implement|to define/);
      expect(String(error)).toContain(method);
    }
  });
});
