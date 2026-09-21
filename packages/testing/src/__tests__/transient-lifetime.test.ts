import { expect, it } from 'vitest';
import { InjectionToken, Scope, defineProvider } from '@velajs/vela';
import { Test } from '../test.js';

it('drains pending asynchronous transient construction before a testing scope closes', async () => {
  let sequence = 0;
  const disposed: number[] = [];
  class Resource {
    readonly id = ++sequence;
    async [Symbol.asyncDispose]() {
      await Promise.resolve();
      disposed.push(this.id);
    }
  }
  const RESOURCE = new InjectionToken<Resource>('async-transient');
  const module = await Test.createTestingModule({
    providers: [
      defineProvider(RESOURCE, {
        scope: Scope.TRANSIENT,
        inject: [],
        useFactory: async () => {
          await Promise.resolve();
          return new Resource();
        },
      }),
    ],
  }).compile();
  let pending: Promise<Resource> | undefined;
  try {
    await module.runInRequestScope((child) => {
      pending = child.resolveAsync(RESOURCE);
    });
    if (!pending) throw new Error('Scope did not start construction');
    const instance = await pending;
    expect(disposed).toEqual([instance.id]);
  } finally {
    await module.close();
  }
  // Eager bootstrap's transient is root-owned; it is also disposed once.
  expect(disposed).toHaveLength(2);
  expect(new Set(disposed).size).toBe(2);
});
