import { describe, expect, it } from 'vitest';
import {
  Controller,
  Get,
  Post,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  REQUEST_CONTEXT,
  EXECUTION_LIFETIME,
  SignedInvocation,
  Scope,
  InternalDispatcher,
  INVOCATION_TRANSPORT,
  URL_SIGNING_SECRET,
  defineProvider,
} from '@velajs/vela';
import { Test } from '../test.js';

describe('testing application lifecycle parity', () => {
  it('dispatches signed internal requests through the real pipeline', async () => {
    @Controller('/internal')
    class InternalController {
      @Post()
      @SignedInvocation()
      execute() {
        return { executed: true };
      }
    }
    const module = await Test.createTestingModule({
      controllers: [InternalController],
      providers: [defineProvider(URL_SIGNING_SECRET, { useValue: 'testing-signing-key' })],
    }).compile();
    try {
      await expect(module.get(InternalDispatcher).run({ path: '/internal' })).resolves.toEqual({
        executed: true,
      });
    } finally {
      await module.close();
    }
  });

  it('recomputes scope when an override introduces a request dependency', async () => {
    const VALUE = new InjectionToken<string>('request-value');
    @Injectable()
    class Consumer {
      constructor(@Inject(VALUE) readonly value: string) {}
    }
    @Controller('/value')
    class ValueController {
      constructor(@Inject(Consumer) readonly consumer: Consumer) {}
      @Get()
      read() {
        return this.consumer.value;
      }
    }
    @Module({
      providers: [Consumer, defineProvider(VALUE, { useValue: 'initial' })],
      controllers: [ValueController],
    })
    class AppModule {}
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(VALUE)
      .useFactory({ inject: [REQUEST_CONTEXT], factory: (context) => context.id })
      .compile();
    try {
      const responses = await Promise.all(
        ['first', 'second'].map((id) =>
          module.http.get('/value').withHeaders({ 'x-request-id': id }).send(),
        ),
      );
      expect(await Promise.all(responses.map((response) => response.text()))).toEqual([
        'first',
        'second',
      ]);
    } finally {
      await module.close();
    }
  });

  it('disposes constructed providers and runs shutdown once for concurrent close', async () => {
    const events: string[] = [];
    @Injectable()
    class Resource {
      onModuleDestroy() {
        events.push('destroy');
      }
      async [Symbol.asyncDispose]() {
        await Promise.resolve();
        events.push('dispose');
      }
    }
    const module = await Test.createTestingModule({ providers: [Resource] }).compile();
    await Promise.all([module.close(), module.close()]);
    expect(events).toEqual(['destroy', 'dispose']);
  });

  it('disposes resources when compilation fails during lifecycle', async () => {
    let disposed = 0;
    @Injectable()
    class Resource {
      [Symbol.dispose]() {
        disposed++;
      }
    }
    @Injectable()
    class Broken {
      constructor(@Inject(Resource) readonly resource: Resource) {}
      onModuleInit() {
        throw new Error('startup failed');
      }
    }
    await expect(
      Test.createTestingModule({ providers: [Resource, Broken] }).compile(),
    ).rejects.toThrow('startup failed');
    expect(disposed).toBe(1);
  });
});

it('restores singleton scope when an override removes a request dependency', async () => {
  const VALUE = new InjectionToken<string>('formerly-request');
  @Injectable()
  class Consumer {
    constructor(@Inject(VALUE) readonly value: string) {}
  }
  const module = await Test.createTestingModule({
    providers: [
      Consumer,
      defineProvider(VALUE, { inject: [REQUEST_CONTEXT], useFactory: (context) => context.id }),
    ],
  })
    .overrideProvider(VALUE)
    .useValue('singleton')
    .compile();
  try {
    expect(module.get(Consumer).value).toBe('singleton');
  } finally {
    await module.close();
  }
});

it('keeps simultaneous applications and asynchronous override factories isolated', async () => {
  const DATABASE = new InjectionToken<{ name: string }>('database');
  @Controller('/database')
  class DatabaseController {
    constructor(@Inject(DATABASE) readonly database: { name: string }) {}
    @Get()
    read() {
      return this.database;
    }
  }
  @Module({
    controllers: [DatabaseController],
    providers: [defineProvider(DATABASE, { useValue: { name: 'production' } })],
  })
  class DatabaseModule {}
  const modules = await Promise.all(
    ['first', 'second'].map((name) =>
      Test.createTestingModule({ imports: [DatabaseModule] })
        .overrideProvider(DATABASE)
        .useFactory({ inject: [], factory: async () => ({ name }) })
        .compile(),
    ),
  );
  try {
    const responses = await Promise.all(
      modules.map((module) => module.http.get('/database').send()),
    );
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      { name: 'first' },
      { name: 'second' },
    ]);
  } finally {
    await Promise.all(modules.map((module) => module.close()));
  }
});

it('attempts every registered cleanup and full application disposal after failure', async () => {
  const events: string[] = [];
  const failure = new Error('fixture cleanup failed');
  @Injectable()
  class Resource {
    [Symbol.dispose]() {
      events.push('resource');
    }
  }
  const module = await Test.createTestingModule({ providers: [Resource] }).compile();
  module.onClose(() => {
    events.push('first');
  });
  module.onClose(async () => {
    await Promise.resolve();
    events.push('second');
    throw failure;
  });
  await expect(module.close()).rejects.toBe(failure);
  expect(events).toEqual(['second', 'first', 'resource']);
  await expect(module.http.get('/').send()).rejects.toThrow('closed');
  expect(() => module.onClose(() => {})).toThrow('closed');
  await expect(module.close()).rejects.toBe(failure);
});

it('waits for active request scopes before disposing root resources', async () => {
  const events: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  @Injectable()
  class RootResource {
    [Symbol.dispose]() {
      events.push('root');
    }
  }
  @Injectable({ scope: Scope.REQUEST })
  class ChildResource {
    constructor(@Inject(RootResource) readonly root: RootResource) {}
    async [Symbol.asyncDispose]() {
      await Promise.resolve();
      events.push('child');
    }
  }
  const module = await Test.createTestingModule({
    providers: [RootResource, ChildResource],
  }).compile();
  const running = module.runInRequestScope(async (child) => {
    child.resolve(ChildResource);
    await barrier;
    events.push('work');
  });
  const closing = module.close();
  await Promise.resolve();
  expect(events).toEqual([]);
  release();
  await Promise.all([running, closing]);
  expect(events).toEqual(['work', 'child', 'root']);
});

it('drains managed deferred work before request providers and root resources close', async () => {
  const events: string[] = [];
  @Injectable({ scope: Scope.REQUEST })
  class Resource {
    [Symbol.dispose]() {
      events.push('disposed');
    }
  }
  const module = await Test.createTestingModule({ providers: [Resource] }).compile();
  await module.runInRequestScope((child) => {
    child.resolve(Resource);
    child.resolve(EXECUTION_LIFETIME).defer(async () => {
      await Promise.resolve();
      events.push('deferred');
    });
    events.push('callback');
  });
  expect(events).toEqual(['callback', 'deferred', 'disposed']);
  await module.close();
});

it('preserves callback and managed completion failures while disposing scope resources', async () => {
  let disposed = false;
  const callbackError = new Error('callback failed');
  const deferredError = new Error('deferred failed');
  @Injectable({ scope: Scope.REQUEST })
  class Resource {
    [Symbol.dispose]() {
      disposed = true;
    }
  }
  const module = await Test.createTestingModule({ providers: [Resource] }).compile();
  try {
    await expect(
      module.runInRequestScope((child) => {
        child.resolve(Resource);
        child.resolve(EXECUTION_LIFETIME).defer(() => {
          throw deferredError;
        });
        throw callbackError;
      }),
    ).rejects.toMatchObject({ errors: [callbackError, deferredError] });
    expect(disposed).toBe(true);
  } finally {
    await module.close();
  }
});

it('preserves an explicitly overridden internal dispatch transport', async () => {
  const module = await Test.createTestingModule({
    providers: [defineProvider(URL_SIGNING_SECRET, { useValue: 'test-secret' })],
  })
    .overrideProvider(INVOCATION_TRANSPORT)
    .useValue(async () => Response.json({ custom: true }))
    .compile();
  try {
    await expect(module.get(InternalDispatcher).run({ path: '/custom' })).resolves.toEqual({
      custom: true,
    });
  } finally {
    await module.close();
  }
});
