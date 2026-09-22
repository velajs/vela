import { expect, it, vi } from 'vitest';
import { contract, parsePayload, scope } from './support';
import { createMemoryReliabilityStore } from '../testing';
import { createOutbox, type ExecutionObserver } from '../index';

contract('memory reference', async () => {
  let time = Date.now();
  const store = createMemoryReliabilityStore({ now: () => time });
  return {
    store,
    other: store,
    shift: async (ms) => {
      time += ms;
    },
    reopen: async () => store,
    close: async () => {},
  };
});
it('contains synchronous and accidental asynchronous observer failures', async () => {
  const store = createMemoryReliabilityStore();
  const observers: ExecutionObserver[] = [
    {
      onStart() {
        throw new Error('start');
      },
    },
    {
      onStart: () => ({
        onEnd() {
          throw new Error('end');
        },
      }),
    },
    {
      onStart: () => ({
        onEnd: async () => {
          throw new Error('async end');
        },
      }),
    },
    // Runtime callers can provide asynchronous functions despite the declared structural contract.
    {
      onStart: (async () => {
        throw new Error('async start');
      }) as unknown as ExecutionObserver['onStart'],
    },
  ];
  await Promise.all(
    observers.map((observer, i) =>
      createOutbox({ store, parsePayload, observer }).enqueue(scope, {
        id: `observed-${i}`,
        payload: { value: 'ok' },
      }),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
});
it('validates namespace before adapter setup and does not invoke application handlers', async () => {
  const run = vi.fn(async (): Promise<never> => {
    throw new Error('Adapter setup should not run');
  });
  const outbox = createOutbox({ store: { run }, parsePayload });
  await expect(
    outbox.enqueue({ tenantId: '', namespace: 'x' }, { id: 'id', payload: { value: 'x' } }),
  ).rejects.toThrow('tenantId');
  expect(run).not.toHaveBeenCalled();
});
