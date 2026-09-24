import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import {
  Controller,
  Post,
  URL_SIGNING_SECRET,
  Injectable,
  InjectionToken,
  REQUEST_CONTEXT,
  defineProvider,
} from '@velajs/vela';
import { SignedInvocation, InternalDispatcher } from '@velajs/vela/dispatch';
import { Test, TestResponse, createTestHttpClient } from '@velajs/testing';
import '@velajs/testing/websocket-node';
import { evaluate } from '@velajs/testing/eval';

const require = createRequire(import.meta.url);

it('imports every testing subpath without optional Node WebSocket peers', async () => {
  expect(typeof evaluate).toBe('function');
  for (const peer of ['@hono/node-server', '@hono/node-ws']) {
    expect(() => require.resolve(peer)).toThrow();
  }
  const module = await Test.createTestingModule({}).compile();
  try {
    await expect(module.ws('/').connect()).rejects.toThrow('required');
  } finally {
    await module.close();
  }
});

it('uses packed finalization, typed override scopes and complete disposal', async () => {
  const events = [];
  class Resource {
    onModuleDestroy() {
      events.push('destroy');
    }
    async [Symbol.asyncDispose]() {
      await Promise.resolve();
      events.push('disposed');
    }
  }
  Injectable()(Resource);
  class Endpoint {
    execute() {
      return { executed: true };
    }
  }
  Controller('/internal')(Endpoint);
  const descriptor = Object.getOwnPropertyDescriptor(Endpoint.prototype, 'execute');
  Post()(Endpoint.prototype, 'execute', descriptor);
  SignedInvocation()(Endpoint.prototype, 'execute', descriptor);
  const VALUE = new InjectionToken('request-value');
  const module = await Test.createTestingModule({
    providers: [
      Resource,
      defineProvider(VALUE, { useValue: 'initial' }),
      defineProvider(URL_SIGNING_SECRET, { useValue: 'packed-test-secret' }),
    ],
    controllers: [Endpoint],
  })
    .overrideProvider(VALUE)
    .useFactory({
      inject: [REQUEST_CONTEXT],
      factory: (context) => context.id,
    })
    .compile();
  try {
    await expect(module.get(InternalDispatcher).run({ path: '/internal' })).resolves.toEqual({
      executed: true,
    });
    const ids = await Promise.all(
      [1, 2].map(() => module.runInRequestScope((child) => child.resolve(VALUE))),
    );
    expect(ids[0]).not.toBe(ids[1]);
    const client = createTestHttpClient({
      baseUrl: 'https://packed.test',
      fetch: (request) => module.fetch(request),
    });
    (await client.post('/internal').send()).assertForbidden();
  } finally {
    await Promise.all([module.close(), module.close()]);
  }
  expect(events).toEqual(['destroy', 'disposed']);
});

it('validates async schema outputs from packed declarations and runtime helpers', async () => {
  let validations = 0;
  const response = new TestResponse(Response.json('7'));
  const schema = {
    '~standard': {
      version: 1,
      vendor: 'test',
      async validate(value) {
        validations++;
        return typeof value === 'string'
          ? { value: Number(value) }
          : { issues: [{ message: 'Expected string' }] };
      },
    },
  };
  expect(await response.json(schema)).toBe(7);
  expect(validations).toBe(1);
  expect(await response.json()).toBe('7');
});
