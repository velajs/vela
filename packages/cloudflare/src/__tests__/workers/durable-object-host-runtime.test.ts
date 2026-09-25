// @ts-expect-error virtual module supplied by @cloudflare/vitest-plugin
import * as cloudflareTest from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { isDurableObjectError } from '../../durable-objects';
import type { Counter } from './entry';

/** The `cloudflare:test` helpers these specs drive. */
interface WorkersTestPool {
  SELF: Fetcher;
  runDurableObjectAlarm(stub: DurableObjectStub<Counter>): Promise<boolean>;
}
const pool: WorkersTestPool = cloudflareTest;

function counter(name: string): DurableObjectStub<Counter> {
  return env.COUNTER.getByName(name);
}

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

describe('VelaDurableObject under workerd', () => {
  it('exposes the host methods as typed RPC methods with DI and durable storage', async () => {
    const stub = counter('rpc-typed');
    expectTypeOf(stub.increment).parameters.toEqualTypeOf<[by: number]>();
    // @ts-expect-error lifecycle hooks and helpers are not RPC methods
    void stub.onModuleInit;
    expect(await stub.increment(2)).toBe(2);
    expect(await stub.increment(3)).toBe(5);

    const snapshot = await stub.snapshot();
    expect(snapshot).toMatchObject({ name: 'rpc-typed', probe: 'workerd-env', storage: true });
  });

  it('boots one context per instance with its own singletons, and a scope per call', async () => {
    const a = counter('isolation-a');
    const b = counter('isolation-b');
    await a.increment(1);
    expect(await b.increment(10)).toBe(10);
    expect(await a.increment(1)).toBe(2);

    const [first, second] = [await a.snapshot(), await a.snapshot()];
    const other = await b.snapshot();
    expect(first.instanceId).toBe(second.instanceId);
    expect(other.instanceId).not.toBe(first.instanceId);
    // Request-scoped providers are built for each RPC call.
    expect(first.callId).not.toBe(second.callId);
  });

  it('serves RPC calls the Worker makes through its binding', async () => {
    const call = () =>
      pool.SELF.fetch('https://worker.test/counters/from-worker', { method: 'POST' });
    expect(await (await call()).json()).toEqual({ count: 1 });
    expect(await (await call()).json()).toEqual({ count: 2 });
    expect(await counter('from-worker').increment(0)).toBe(2);
  });

  it('delegates the alarm and fetch handlers to the host', async () => {
    const stub = counter('handlers');
    await stub.scheduleAlarm();
    expect(await pool.runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.alarms()).toBe(1);

    const response = await stub.fetch('https://counter.test/status');
    expect(await response.json()).toEqual({ path: '/status', name: 'handlers' });
  });

  it('runs guards on RPC methods', async () => {
    const error = await rejection(counter('guarded').denied());
    expect(isDurableObjectError(error)).toBe(true);
    expect(error).toMatchObject({ status: 403, code: 'forbidden', message: 'Forbidden' });
  });

  it('reports a failure and redacts it across the RPC boundary', async () => {
    const stub = counter('redaction');
    const error = await rejection(stub.leak());
    expect(isDurableObjectError(error)).toBe(true);
    expect(error).toMatchObject({
      status: 500,
      code: 'internal',
      message: 'Internal Server Error',
    });
    const delivered = everything(error);
    expect(delivered).not.toContain('secret');
    // workerd appends the caller's own frames; none of the object's crosses.
    expect(delivered).not.toContain('entry.ts');
    expect(delivered).not.toContain('durable-object/');
    // The runtime adapter of the app definition configured the object's context.
    expect(await stub.reported()).toEqual(['secret database detail']);
  });

  it('rejects calls to an object that failed to start without saying why', async () => {
    const error = await rejection(env.BROKEN_COUNTER.getByName('broken').ping());
    expect(error).toMatchObject({ message: 'Internal Server Error' });
    expect(everything(error)).not.toContain('secret startup detail');
  });
});
