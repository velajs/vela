import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Controller,
  ENV,
  Get,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  VelaFactory,
  defineProvider,
  type ExecutionLifetime,
} from '@velajs/vela';
import { createExecutionScope, runInEntrypointScope } from '@velajs/vela/module-kit';
import {
  acquireCrudDatabases,
  createCrudDatabaseRegistry,
  CrudModule,
  CRUD_DATABASES,
  crudResourceToken,
  defineCrudDatabase,
  defineCrudFeature,
  defineModel,
  type CrudDatabaseRegistry,
  type CrudResource,
} from '@velajs/crud';
import { MemoryStore, transactionalMemoryAdapter } from '@velajs/crud-memory';

const model = defineModel({
  name: 'item',
  tableName: 'items',
  id: 'client',
  timestamps: false,
  schema: z.object({ id: z.string(), title: z.string() }),
});
function registry(store = new MemoryStore()) {
  return createCrudDatabaseRegistry([
    defineCrudDatabase('main', {
      handle: store,
      resources: {
        item: { model, adapter: transactionalMemoryAdapter({ tableName: 'items', store }) },
      },
    }),
  ]);
}
const resourceToken = crudResourceToken('item', 'main');
const environment = new InjectionToken<string>('synthetic-environment');
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function fixture(label: string, options: { cleanupFailure?: boolean } = {}) {
  const acquired: string[] = [],
    released: string[] = [],
    lifetimes: ExecutionLifetime[] = [];
  @Module({ providers: [defineProvider(environment, { useValue: label })], exports: [environment] })
  class Bindings {}
  const databaseModule = CrudModule.forRequestAsync({
    imports: [Bindings],
    inject: [environment],
    useFactory: (lifetime, env) =>
      acquireCrudDatabases({
        signal: lifetime.signal,
        acquire: () => {
          const id = `${env}:${lifetime.id}`;
          acquired.push(id);
          lifetimes.push(lifetime);
          const store = new MemoryStore();
          store.table('items').set('1', { id: '1', title: id });
          return { id, store };
        },
        create: ({ store }) => registry(store),
        release: ({ id }) => {
          released.push(id);
          if (options.cleanupFailure) throw new Error('release failed');
        },
      }),
  });
  @Injectable()
  class Consumer {
    constructor(@Inject(resourceToken) readonly resource: CrudResource) {}
  }
  @Controller('native')
  class NativeController {
    constructor(
      @Inject(CRUD_DATABASES) readonly databases: CrudDatabaseRegistry,
      @Inject(Consumer) readonly consumer: Consumer,
    ) {}
    @Get('same') async same() {
      const first = this.databases.get('main');
      await this.consumer.resource.execute('list', {});
      return { same: first === this.databases.get('main') };
    }
    @Get('error') error(): never {
      throw new Error('handler failed');
    }
    @Get('complete') complete(): Response {
      const resource = this.consumer.resource;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await resource.execute('list', {});
            controller.enqueue(new TextEncoder().encode('done'));
            controller.close();
          },
        }),
      );
    }
    @Get('broken') broken(): Response {
      return new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            throw new Error('body failed');
          },
        }),
      );
    }
    @Get('stream') stream(): Response {
      const resource = this.consumer.resource;
      let read = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (read) return;
            read = true;
            const result = await resource.execute('list', {});
            controller.enqueue(new TextEncoder().encode(JSON.stringify(result)));
            // Deliberately stays open until the caller cancels.
          },
        }),
      );
    }
  }
  @Module({
    imports: [
      databaseModule,
      CrudModule.forFeature([defineCrudFeature({ path: '/items', model, database: 'main' })]),
    ],
    providers: [Consumer],
    controllers: [NativeController],
  })
  class App {}
  return { app: await VelaFactory.create(App), acquired, released, lifetimes, Consumer };
}

describe('request-owned CRUD databases', () => {
  it('never acquires during bootstrap/root resolution, bubbles through consumers and rejects bare scopes', async () => {
    const f = await fixture('a');
    try {
      expect(f.acquired).toEqual([]);
      await expect(f.app.getContainer().resolveAsync(f.Consumer)).rejects.toThrow(
        /request.scoped/i,
      );
      const bare = f.app.getContainer().createChild();
      await expect(bare.resolveAsync(CRUD_DATABASES)).rejects.toThrow(/lifetime|execution/i);
      await bare.dispose();
      expect(f.acquired).toEqual([]);
      const response = await f.app.getHonoApp().request('/native/same');
      expect(await response.json()).toEqual({ same: true });
      await tick();
      expect(f.acquired).toHaveLength(1);
      expect(f.released).toEqual(f.acquired);
    } finally {
      await f.app.close();
    }
  });

  it('isolates overlapping HTTP/event scopes and environments, waits for managed work and rejects expired resources', async () => {
    const a = await fixture('a'),
      b = await fixture('b');
    const scopes = [
      createExecutionScope(a.app.getContainer()),
      createExecutionScope(a.app.getContainer()),
      createExecutionScope(b.app.getContainer()),
    ];
    try {
      const resources = await Promise.all(
        scopes.map((scope) => scope.container.resolveAsync(resourceToken)),
      );
      const results = await Promise.all(
        resources.map((resource) => resource.execute('read', { id: '1' })),
      );
      expect(JSON.stringify(results[0])).toContain('a:');
      expect(JSON.stringify(results[2])).toContain('b:');
      expect(
        new Set(resources.map((resource) => resource.config.adapter.transactionOwner)).size,
      ).toBe(3);
      const gate = Promise.withResolvers<void>();
      scopes[0]!.lifetime.waitUntil(
        gate.promise.then(async () => {
          await resources[0]!.execute('list', {});
        }),
      );
      const finishing = scopes[0]!.finish();
      await tick();
      expect(a.released).toEqual([]);
      const responses = await Promise.all([
        a.app.getHonoApp().request('/items/1'),
        b.app.getHonoApp().request('/items/1'),
      ]);
      for (const response of responses) expect(response.status, await response.text()).toBe(200);
      gate.resolve();
      await finishing;
      await expect(resources[0]!.execute('list', {})).rejects.toThrow('closed');
      await Promise.all(scopes.map((scope) => scope.finish()));
      expect(new Set(a.released).size).toBe(a.acquired.length);
      expect(new Set(b.released).size).toBe(b.acquired.length);
    } finally {
      await Promise.all([a.app.close(), b.app.close()]);
    }
  });

  it('releases after handler errors, body cancellation and cooperative event cancellation', async () => {
    const f = await fixture('a');
    try {
      const bad = await f.app.getHonoApp().request('/native/error');
      expect(bad.status).toBe(500);
      await bad.text();
      await tick();
      expect(f.released).toHaveLength(1);
      const stream = await f.app.getHonoApp().request('/native/stream');
      const reader = stream.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      expect(f.released).toHaveLength(1);
      await reader.cancel();
      await tick();
      expect(f.released).toHaveLength(2);
      const abort = new AbortController();
      await runInEntrypointScope(
        f.app.getContainer(),
        async (child) => {
          const resource = await child.resolveAsync(resourceToken);
          abort.abort(new Error('canceled'));
          expect(f.released).toHaveLength(2);
          await resource.execute('list', {}); // cancellation never tears down active work
        },
        { signal: abort.signal },
      );
      expect(f.released).toHaveLength(3);
    } finally {
      await f.app.close();
    }
  });

  it('logs managed release failure once and still closes the invocation', async () => {
    const f = await fixture('a', { cleanupFailure: true });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const scope = createExecutionScope(f.app.getContainer());
      const resource = await scope.container.resolveAsync(resourceToken);
      await scope.finish();
      await scope.finish();
      expect(f.released).toHaveLength(1);
      expect(log).toHaveBeenCalledWith(
        'Error disposing instance:',
        expect.objectContaining({ message: 'release failed' }),
      );
      await expect(resource.execute('list', {})).rejects.toThrow('closed');
    } finally {
      log.mockRestore();
      await f.app.close();
    }
  });

  it('rejects mixed application/request registrations deterministically', async () => {
    @Module({
      imports: [
        CrudModule.forRoot({ databases: registry() }),
        CrudModule.forRequestAsync({
          inject: [],
          useFactory: () =>
            acquireCrudDatabases({ acquire: () => ({}), create: () => registry(), release() {} }),
        }),
        CrudModule.forFeature([defineCrudFeature({ path: '/items', model, database: 'main' })]),
      ],
    })
    class Mixed {}
    await expect(VelaFactory.create(Mixed)).rejects.toThrow(/multiple|ambiguous/i);
  });
});

describe('database acquisition boundary', () => {
  it('releases exactly once after successful creation, rejects re-leasing and app promotion', async () => {
    const source = registry();
    const release = vi.fn();
    const lease = await acquireCrudDatabases({
      acquire: () => ({}),
      create: () => source,
      release,
    });
    expect(() => lease.databases.forApplication()).toThrow('cannot become application');
    await expect(
      acquireCrudDatabases({ acquire: () => ({}), create: () => source, release }),
    ).rejects.toThrow('already been leased');
    const disposal = lease.dispose();
    expect(lease.dispose()).toBe(disposal);
    await disposal;
    expect(release).toHaveBeenCalledTimes(2);
    expect(() => lease.databases.get('main')).toThrow('closed');
  });

  it('preserves acquisition/construction/cleanup failures and releases aborted acquisitions', async () => {
    const release = vi.fn();
    const primary = new Error('primary');
    const cleanup = new Error('cleanup');
    await expect(
      acquireCrudDatabases({
        acquire: () => {
          throw primary;
        },
        create: () => registry(),
        release,
      }),
    ).rejects.toBe(primary);
    expect(release).not.toHaveBeenCalled();
    await expect(
      acquireCrudDatabases({
        acquire: () => ({}),
        create: () => {
          throw primary;
        },
        release: () => {
          throw cleanup;
        },
      }),
    ).rejects.toMatchObject({ errors: [primary, cleanup] });
    const abort = new AbortController();
    await expect(
      acquireCrudDatabases({
        signal: abort.signal,
        acquire: () => {
          abort.abort(primary);
          return {};
        },
        create: () => registry(),
        release,
      }),
    ).rejects.toBe(primary);
    expect(release).toHaveBeenCalledTimes(1);
    const lease = await acquireCrudDatabases({
      acquire: () => ({}),
      create: () => registry(),
      release: () => {
        throw cleanup;
      },
    });
    await expect(lease.dispose()).rejects.toBe(cleanup);
    await expect(lease.dispose()).rejects.toBe(cleanup);
  });
});

it('rejects two distinct request factories but permits reimporting one shared registration', async () => {
  const acquire = vi.fn(() =>
    acquireCrudDatabases({ acquire: () => ({}), create: () => registry(), release() {} }),
  );
  const one = CrudModule.forRequestAsync({ useFactory: acquire });
  const two = CrudModule.forRequestAsync({ useFactory: acquire });
  @Module({ imports: [one, two] })
  class Duplicate {}
  await expect(VelaFactory.create(Duplicate)).rejects.toThrow('Multiple CRUD');
  @Module({ imports: [one, one] })
  class Shared {}
  const app = await VelaFactory.create(Shared);
  expect(acquire).not.toHaveBeenCalled();
  await app.close();
});

it('cleans a failed new claim while preserving an already claimed lease', async () => {
  const release = vi.fn();
  const open = { active: true } as ExecutionLifetime;
  const closed = { active: false } as ExecutionLifetime;
  const create = () =>
    acquireCrudDatabases({ acquire: () => ({}), create: () => registry(), release });
  const abandoned = await create();
  await expect(abandoned.claim(closed)).rejects.toThrow('lifetime is closed');
  expect(release).toHaveBeenCalledTimes(1);
  const claimed = await create();
  await claimed.claim(open);
  await expect(claimed.claim(closed)).rejects.toThrow('already owned');
  expect(release).toHaveBeenCalledTimes(1);
  await claimed.dispose();
  expect(release).toHaveBeenCalledTimes(2);
});

it('guards retained stores against calls and mutation after disposal', async () => {
  const store = {
    async log() {},
    async query() {
      return [];
    },
    marker: 1,
  };
  const source = registry().get('main');
  const lease = await acquireCrudDatabases({
    acquire: () => ({}),
    create: () => createCrudDatabaseRegistry([{ ...source, auditStore: store }]),
    release() {},
  });
  const guarded = lease.databases.get('main').auditStore!;
  const query = guarded.query;
  await lease.dispose();
  expect(() => query()).toThrow('closed');
  expect(() => Reflect.set(guarded, 'marker', 2)).toThrow('closed');
  expect(() => Reflect.deleteProperty(guarded, 'marker')).toThrow('closed');
  expect(() => Reflect.defineProperty(guarded, 'marker', { value: 3 })).toThrow('closed');
  expect(store.marker).toBe(1);
});

it('rejects unjoined operations across aliases sharing one lease, and admits joined scopes', async () => {
  const native = registry().get('main');
  const lease = await acquireCrudDatabases({
    acquire: () => native.handle,
    create: () => createCrudDatabaseRegistry([native, { ...native, name: 'alias' }]),
    release() {},
  });
  const a = lease.databases.get('main').resources.item!.adapter.runtime;
  const alias = lease.databases.get('alias').resources.item!.adapter.runtime;
  try {
    await a.transaction(async (scope) => {
      await a.create({ id: 'one', title: 'joined' }, scope);
      await expect(alias.requestScope(async () => {})).rejects.toThrow(
        'already has an active operation',
      );
      await expect(a.transaction(async () => {})).rejects.toThrow(
        'already has an active operation',
      );
      expect(await a.readOne({ field: 'id', value: 'one' }, {}, scope)).toMatchObject({
        title: 'joined',
      });
    });
    await alias.requestScope(async (scope) => {
      expect(await alias.readOne({ field: 'id', value: 'one' }, {}, scope)).toMatchObject({
        title: 'joined',
      });
    });
  } finally {
    await lease.dispose();
  }
});

it('waits for a pending acquisition before cleanup after cancellation', async () => {
  const pending = Promise.withResolvers<object>();
  const abort = new AbortController();
  const release = vi.fn();
  const create = vi.fn(() => registry());
  const acquisition = acquireCrudDatabases({
    signal: abort.signal,
    acquire: () => pending.promise,
    create,
    release,
  });
  abort.abort(new Error('canceled'));
  await Promise.resolve();
  expect(release).not.toHaveBeenCalled();
  const handle = {};
  pending.resolve(handle);
  await expect(acquisition).rejects.toThrow('canceled');
  expect(create).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledExactlyOnceWith(handle);
});

it('rejects repeated native acquisition without closing the original invocation resource', async () => {
  const handle = {},
    release = vi.fn();
  const create = () =>
    acquireCrudDatabases({ acquire: () => handle, create: () => registry(), release });
  const original = await create();
  await expect(create()).rejects.toThrow('already acquired');
  expect(release).not.toHaveBeenCalled();
  await original.dispose();
  expect(release).toHaveBeenCalledTimes(1);
});

it('releases a constructed lease when feature validation fails after acquisition', async () => {
  const release = vi.fn();
  @Module({
    imports: [
      CrudModule.forRequestAsync({
        useFactory: () =>
          acquireCrudDatabases({
            acquire: () => ({}),
            create: () =>
              createCrudDatabaseRegistry([
                defineCrudDatabase('main', { handle: {}, resources: {} }),
              ]),
            release,
          }),
      }),
      CrudModule.forFeature([defineCrudFeature({ path: '/items', model, database: 'main' })]),
    ],
  })
  class Invalid {}
  const app = await VelaFactory.create(Invalid);
  try {
    await expect(
      runInEntrypointScope(app.getContainer(), (child) => child.resolveAsync(resourceToken)),
    ).rejects.toThrow('Unknown resource');
    expect(release).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});

it('releases after streamed EOF and body errors', async () => {
  const f = await fixture('stream');
  try {
    const complete = await f.app.getHonoApp().request('/native/complete');
    expect(f.released).toHaveLength(0);
    expect(await complete.text()).toBe('done');
    await tick();
    expect(f.released).toHaveLength(1);
    const broken = await f.app.getHonoApp().request('/native/broken');
    await expect(broken.text()).rejects.toThrow('body failed');
    await tick();
    expect(f.released).toHaveLength(2);
  } finally {
    await f.app.close();
  }
});

it('keeps startup duplicate-resource diagnostics for a named default database', async () => {
  @Module({
    imports: [
      CrudModule.forRoot({
        databases: createCrudDatabaseRegistry([registry().get('main')], {
          defaultDatabase: 'main',
        }),
      }),
      CrudModule.forFeature([defineCrudFeature({ path: '/first', model })]),
      CrudModule.forFeature([defineCrudFeature({ path: '/second', model })]),
    ],
  })
  class Duplicates {}
  await expect(VelaFactory.create(Duplicates)).rejects.toThrow('Duplicate CRUD resource');
});

it('reuses one module declaration across overlapping environments without capturing bindings', async () => {
  const releases: string[] = [];
  @Module({
    imports: [
      CrudModule.forRequestAsync({
        inject: [ENV],
        useFactory: (lifetime, env) =>
          acquireCrudDatabases({
            acquire: () => {
              const label: unknown = Reflect.get(env, 'LABEL');
              if (typeof label !== 'string') throw new TypeError('Missing environment label');
              const store = new MemoryStore();
              store.table('items').set('same', { id: 'same', title: label });
              return { store, label, id: lifetime.id };
            },
            create: ({ store }) => registry(store),
            release: ({ label }) => {
              releases.push(label);
            },
          }),
      }),
      CrudModule.forFeature([defineCrudFeature({ path: '/items', model, database: 'main' })]),
    ],
  })
  class SharedApp {}
  const a = await VelaFactory.create(SharedApp, { env: { LABEL: 'one' } });
  const b = await VelaFactory.create(SharedApp, { env: { LABEL: 'two' } });
  try {
    const responses = await Promise.all([
      a.getHonoApp().request('/items/same'),
      b.getHonoApp().request('/items/same'),
    ]);
    expect(await responses[0]!.json()).toMatchObject({ result: { title: 'one' } });
    expect(await responses[1]!.json()).toMatchObject({ result: { title: 'two' } });
    await tick();
    expect(releases.toSorted()).toEqual(['one', 'two']);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});
