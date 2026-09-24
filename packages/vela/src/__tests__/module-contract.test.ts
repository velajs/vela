import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigurableModuleBuilder,
  Controller,
  Get,
  Global,
  InjectionToken,
  Module,
  VelaFactory,
  defineModule,
  defineProvider,
  type DynamicModule,
  type Type,
} from '../index';
import { EventEmitter, EventEmitterModule } from '../event-emitter';
import { HealthCheckService, HealthModule } from '../health';
import { LoggingModule } from '../logging';
import * as moduleKit from '../module-kit';
import { referenceKey } from '../module-kit';
import { ScheduleExecutor, ScheduleNodeModule } from '../schedule-node';

afterEach(() => {
  vi.restoreAllMocks();
});

interface BucketDriver {
  read(key: string): string | undefined;
}

interface BucketOptions {
  name?: string;
  driver: BucketDriver;
  label?: string;
}

const LABEL = new InjectionToken<string>('module contract label');

const driver = (value: string): BucketDriver => ({ read: () => value });

// `name` decides what the module contributes, so it is structural: known at
// the call site of both forRoot and forRootAsync. The driver and label are not.
const { ConfigurableModuleClass: BucketBase, MODULE_OPTIONS_TOKEN: BUCKET_OPTIONS } = defineModule<
  BucketOptions,
  'name'
>({
  name: 'Bucket',
  structural: ['name'],
  setup: ({ OPTIONS, options }) => ({
    providers: [
      defineProvider(LABEL, {
        inject: [OPTIONS],
        useFactory: (resolved) => `${options.name ?? 'default'}:${resolved.label ?? '-'}`,
      }),
    ],
    exports: [LABEL, OPTIONS],
  }),
});
class BucketModule extends BucketBase {}

describe('module contract: keys come from structural fields only', () => {
  it('keys an instance by its structural fields and ignores the rest', () => {
    const first = BucketModule.forRoot({ name: 'files', driver: driver('a'), label: 'x' });
    const second = BucketModule.forRoot({ name: 'files', driver: driver('b'), label: 'y' });
    const other = BucketModule.forRoot({ name: 'images', driver: driver('a') });
    expect(first.key).toBe(second.key);
    expect(other.key).not.toBe(first.key);
  });

  it('gives forRoot and forRootAsync with the same structural fields the same key', () => {
    const sync = BucketModule.forRoot({ name: 'files', driver: driver('a') });
    const deferred = BucketModule.forRootAsync({
      name: 'files',
      useFactory: () => ({ driver: driver('a') }),
    });
    expect(deferred.key).toBe(sync.key);
  });

  it('keys a module without structural fields once per class', () => {
    const { ConfigurableModuleClass } = defineModule<{ ttl: number }>({ name: 'Plain' });
    class PlainModule extends ConfigurableModuleClass {}
    const short = PlainModule.forRoot({ ttl: 1 });
    const long = PlainModule.forRoot({ ttl: 60 });
    const deferred = PlainModule.forRootAsync({ useFactory: () => ({ ttl: 5 }) });
    expect(long.key).toBe(short.key);
    expect(deferred.key).toBe(short.key);
    expect(PlainModule.forRoot({ ttl: 1, key: 'secondary' }).key).toBe('secondary');
  });

  it('keeps one instance of each first-party module without options across both forms', async () => {
    const cases: Array<[bare: Type, root: DynamicModule, token: Type]> = [
      [ScheduleNodeModule, ScheduleNodeModule.forRoot(), ScheduleExecutor],
      [EventEmitterModule, EventEmitterModule.forRoot(), EventEmitter],
      [HealthModule, HealthModule.forRoot(), HealthCheckService],
    ];
    for (const [bare, root, token] of cases) {
      // A library imports the bare class; the application uses forRoot().
      @Module({ imports: [bare] })
      class LibraryModule {}
      @Module({ imports: [LibraryModule, root] })
      class AppModule {}
      const app = await VelaFactory.create(AppModule, { diagnostics: 'throw' });
      expect(app.getContainer().getOwnerModuleIds(token)).toEqual([`${bare.name}#default`]);
      await app.close();
    }
  });

  it('passes setup only the structural fields, for forRoot as for forRootAsync', () => {
    const seen: unknown[] = [];
    const { ConfigurableModuleClass } = defineModule<BucketOptions, 'name'>({
      name: 'SetupProbe',
      structural: ['name'],
      setup: ({ options }) => {
        seen.push({ ...options });
        return {};
      },
    });
    class ProbeModule extends ConfigurableModuleClass {}
    ProbeModule.forRoot({ name: 'files', driver: driver('a'), label: 'x' });
    ProbeModule.forRootAsync({ name: 'files', useFactory: () => ({ driver: driver('a') }) });
    expect(seen).toEqual([{ name: 'files' }, { name: 'files' }]);
  });

  it('fails bootstrap on a repeated structural key whose other options differ', async () => {
    @Module({
      imports: [
        BucketModule.forRoot({ name: 'files', driver: driver('a') }),
        BucketModule.forRoot({ name: 'files', driver: driver('b') }),
      ],
    })
    class AppModule {}
    // Keeping either configuration would run the other feature on it, so no
    // diagnostics policy lets the application start.
    for (const diagnostics of ['throw', 'log', 'silent'] as const) {
      await expect(VelaFactory.create(AppModule, { diagnostics })).rejects.toThrow(
        /BucketModule#\w+ was imported again with different options/,
      );
    }
    await expect(VelaFactory.create(AppModule)).rejects.toThrow(/different options/);
  });

  it('lets distinct structural fields coexist as separate instances', async () => {
    @Module({
      imports: [
        BucketModule.forRoot({ name: 'files', driver: driver('a') }),
        BucketModule.forRoot({ name: 'images', driver: driver('b') }),
      ],
    })
    class AppModule {}
    const app = await VelaFactory.create(AppModule, { diagnostics: 'throw' });
    expect(app.getContainer().getOwnerModuleIds(BUCKET_OPTIONS)).toHaveLength(2);
    await app.close();
  });
});

interface MountOptions {
  path: string;
  label?: string;
}

// Like a storage bucket's HTTP controller: setup builds a controller class per
// call, so two calls with equal inputs still produce two distinct classes.
const { ConfigurableModuleClass: MountBase } = defineModule<MountOptions, 'path'>({
  name: 'Mount',
  structural: ['path'],
  setup: ({ options }) => {
    @Controller(options.path)
    class MountController {
      @Get('/read')
      read(): string {
        return 'mounted';
      }
    }
    return { controllers: [MountController] };
  },
});
class MountModule extends MountBase {}

const routesAt = (routes: ReadonlyArray<{ method: string; path: string }>, path: string) =>
  routes.filter((route) => route.method === 'GET' && route.path === path);

describe('module contract: a repeated (class, key) contributes nothing of its own', () => {
  it('mounts the controllers of an identical repeat built by a second call once', async () => {
    @Module({
      imports: [MountModule.forRoot({ path: '/mount' }), MountModule.forRoot({ path: '/mount' })],
    })
    class AppModule {}
    const app = await VelaFactory.create(AppModule, { diagnostics: 'throw' });
    expect(routesAt(app.describeRoutes(), '/mount/read')).toHaveLength(1);
    await app.close();
  });

  it('ignores the controllers of a repeat whose global flag differs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    @Module({
      imports: [
        MountModule.forRoot({ path: '/mount' }),
        MountModule.forRoot({ path: '/mount', isGlobal: true }),
      ],
    })
    class AppModule {}
    const app = await VelaFactory.create(AppModule);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/different global flag/));
    expect(routesAt(app.describeRoutes(), '/mount/read')).toHaveLength(1);
    await app.close();
  });

  it('still collects the extra controllers of a hand-written repeat', async () => {
    @Controller('/extra')
    class ExtraController {
      @Get('/read')
      read(): string {
        return 'extra';
      }
    }
    @Module({})
    class HandWritten {}
    @Module({
      imports: [
        { module: HandWritten, key: 'one' },
        { module: HandWritten, key: 'one', controllers: [ExtraController] },
      ],
    })
    class AppModule {}
    const app = await VelaFactory.create(AppModule, { diagnostics: 'throw' });
    expect(routesAt(app.describeRoutes(), '/extra/read')).toHaveLength(1);
    await app.close();
  });
});

describe('module contract: registration controls never reach the options', () => {
  it('strips key, lazy and extras before hashing and before registering OPTIONS', async () => {
    const plain = BucketModule.forRoot({ name: 'files', driver: driver('a') });
    const flagged = BucketModule.forRoot({
      name: 'files',
      driver: driver('a'),
      isGlobal: true,
      lazy: true,
    });
    expect(flagged.key).toBe(plain.key);

    const shared = driver('a');
    @Module({
      imports: [BucketModule.forRoot({ name: 'files', driver: shared, isGlobal: true, key: 'k' })],
    })
    class AppModule {}
    const app = await VelaFactory.create(AppModule, { diagnostics: 'throw' });
    expect(app.get(BUCKET_OPTIONS)).toEqual({ name: 'files', driver: shared });
    await app.close();
  });

  it('strips custom extras too', async () => {
    const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<
      { ttl: number },
      never,
      { isGlobal?: boolean; audit?: boolean }
    >({
      name: 'Audited',
      extras: { isGlobal: false, audit: false },
      transform: (definition, extras) => ({
        ...definition,
        ...(extras.isGlobal ? { global: true } : {}),
      }),
    });
    @Module({})
    class AuditedModule extends ConfigurableModuleClass {}
    const audited = AuditedModule.forRoot({ ttl: 5, audit: true });
    expect(audited.key).toBe(AuditedModule.forRoot({ ttl: 5 }).key);

    @Module({ imports: [audited] })
    class AppModule {}
    const app = await VelaFactory.create(AppModule, { diagnostics: 'throw' });
    expect(app.get(MODULE_OPTIONS_TOKEN)).toEqual({ ttl: 5 });
    await app.close();
  });

  it('keeps async structural fields authoritative and rejects them from the factory', async () => {
    const shared = driver('a');
    @Module({
      imports: [
        BucketModule.forRootAsync({
          name: 'files',
          useFactory: () => ({ driver: shared, label: 'async' }),
        }),
      ],
    })
    class AppModule {}
    const app = await VelaFactory.create(AppModule, { diagnostics: 'throw' });
    expect(app.get(BUCKET_OPTIONS)).toEqual({ name: 'files', driver: shared, label: 'async' });
    expect(app.get(LABEL)).toBe('files:async');
    await app.close();

    const leaky: () => Pick<BucketOptions, 'driver'> = () => ({ driver: shared, name: 'other' });
    @Module({ imports: [BucketModule.forRootAsync({ name: 'files', useFactory: leaky })] })
    class LeakyModule {}
    await expect(VelaFactory.create(LeakyModule)).rejects.toThrow(
      /BucketModule\.forRootAsync: the factory returned the structural option 'name'/,
    );

    // Omitting a structural field at the call site does not let the factory supply it.
    @Module({ imports: [BucketModule.forRootAsync({ useFactory: leaky })] })
    class UndeclaredModule {}
    await expect(VelaFactory.create(UndeclaredModule)).rejects.toThrow(
      /factory returned the structural option 'name'/,
    );
  });

  it('rejects an async call-site option the spec leaves out of its structural list', () => {
    // `label` is declared structural in the type but missing from the list, so
    // it would reach neither setup nor OPTIONS.
    const { ConfigurableModuleClass } = defineModule<BucketOptions, 'name' | 'label'>({
      name: 'Unlisted',
      structural: ['name'],
    });
    class UnlistedModule extends ConfigurableModuleClass {}
    expect(() =>
      UnlistedModule.forRootAsync({
        name: 'files',
        label: 'x',
        useFactory: () => ({ driver: driver('a') }),
      }),
    ).toThrow(/UnlistedModule\.forRootAsync: 'label' is neither a structural option/);
    // An explicitly undefined field carries nothing, so it is not rejected.
    expect(
      UnlistedModule.forRootAsync({
        name: 'files',
        label: undefined,
        useFactory: () => ({ driver: driver('a') }),
      }).key,
    ).toBe(UnlistedModule.forRoot({ name: 'files', driver: driver('a') }).key);
  });

  it('reports the same (class, key) imported with different global flags', async () => {
    const shared = driver('a');
    const local = BucketModule.forRoot({ name: 'files', driver: shared });
    const global = BucketModule.forRoot({ name: 'files', driver: shared, isGlobal: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const imports of [
      [local, global],
      [global, local],
    ]) {
      @Module({ imports })
      class AppModule {}
      await expect(VelaFactory.create(AppModule, { diagnostics: 'throw' })).rejects.toThrow(
        /BucketModule#\w+ was imported again with a different global flag/,
      );

      warn.mockClear();
      const app = await VelaFactory.create(AppModule);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/different global flag/));
      expect(app.get(BUCKET_OPTIONS)).toEqual({ name: 'files', driver: shared });
      await app.close();
    }
  });

  it('fails bootstrap on a repeat whose options and global flag both differ, in either order', async () => {
    // The global flag must not hide the other difference: keeping the first
    // definition would run the second import's consumers on its driver.
    const local = BucketModule.forRoot({ name: 'files', driver: driver('private') });
    const global = BucketModule.forRoot({
      name: 'files',
      driver: driver('public'),
      isGlobal: true,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const imports of [
      [local, global],
      [global, local],
    ]) {
      @Module({ imports })
      class AppModule {}
      for (const diagnostics of ['throw', 'log', 'silent'] as const) {
        await expect(VelaFactory.create(AppModule, { diagnostics })).rejects.toThrow(
          /BucketModule#\w+ was imported again with different options/,
        );
      }
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats an extra at its default and an undefined option as absent', async () => {
    const shared = driver('a');
    const inject: [] = [];
    const useFactory = () => ({ driver: shared });
    const cases: DynamicModule[][] = [
      [
        BucketModule.forRoot({ name: 'files', driver: shared }),
        BucketModule.forRoot({ name: 'files', driver: shared, isGlobal: false }),
        BucketModule.forRoot({ name: 'files', driver: shared, label: undefined }),
        BucketModule.forRoot({
          name: 'files',
          driver: shared,
          isGlobal: undefined,
          key: undefined,
        }),
      ],
      [
        BucketModule.forRootAsync({ name: 'files', inject, useFactory }),
        BucketModule.forRootAsync({ name: 'files', inject, useFactory, isGlobal: false }),
        BucketModule.forRootAsync({ name: 'files', inject, useFactory, lazy: undefined }),
      ],
      // An undefined structural field keys and sets up the instance like an absent one.
      [
        BucketModule.forRoot({ driver: shared }),
        BucketModule.forRoot({ name: undefined, driver: shared }),
      ],
    ];
    for (const imports of cases) {
      expect(new Set(imports.map((definition) => definition.key)).size).toBe(1);
      @Module({ imports })
      class AppModule {}
      const app = await VelaFactory.create(AppModule, { diagnostics: 'throw' });
      expect(app.getContainer().getOwnerModuleIds(BUCKET_OPTIONS)).toHaveLength(1);
      await app.close();
    }
  });

  it('compares custom extras merged over their defaults', async () => {
    const { ConfigurableModuleClass } = defineModule<
      { ttl: number },
      never,
      { isGlobal?: boolean; audit?: boolean }
    >({
      name: 'Defaulted',
      extras: { isGlobal: true, audit: false },
      transform: (definition, extras) => ({
        ...definition,
        ...(extras.isGlobal ? { global: true } : {}),
      }),
    });
    class DefaultedModule extends ConfigurableModuleClass {}

    @Module({
      imports: [
        DefaultedModule.forRoot({ ttl: 5 }),
        DefaultedModule.forRoot({ ttl: 5, isGlobal: true, audit: false }),
        DefaultedModule.forRoot({ ttl: 5, audit: undefined }),
      ],
    })
    class Equivalent {}
    const app = await VelaFactory.create(Equivalent, { diagnostics: 'throw' });
    await app.close();

    @Module({
      imports: [
        DefaultedModule.forRoot({ ttl: 5 }),
        DefaultedModule.forRoot({ ttl: 5, audit: true }),
      ],
    })
    class Audited {}
    await expect(VelaFactory.create(Audited, { diagnostics: 'log' })).rejects.toThrow(
      /DefaultedModule#\w+ was imported again with different options/,
    );

    // A custom transform may read any extra, isGlobal included, for more than
    // visibility, so every extra it receives is compared as an option.
    @Module({
      imports: [
        DefaultedModule.forRoot({ ttl: 5 }),
        DefaultedModule.forRoot({ ttl: 5, isGlobal: false }),
      ],
    })
    class Local {}
    await expect(VelaFactory.create(Local, { diagnostics: 'log' })).rejects.toThrow(
      /DefaultedModule#\w+ was imported again with different options/,
    );
  });

  it('compares the default transform isGlobal against its own default', async () => {
    // LoggingModule is global unless a call site says otherwise.
    @Module({ imports: [LoggingModule.forRoot({}), LoggingModule.forRoot({ isGlobal: true })] })
    class Equivalent {}
    const app = await VelaFactory.create(Equivalent, { diagnostics: 'throw' });
    await app.close();

    @Module({ imports: [LoggingModule.forRoot({}), LoggingModule.forRoot({ isGlobal: false })] })
    class Local {}
    await expect(VelaFactory.create(Local, { diagnostics: 'throw' })).rejects.toThrow(
      /LoggingModule#application was imported again with a different global flag/,
    );
  });

  it('reports a global instance repeated after a bare import of its class', async () => {
    @Module({})
    class Plain {}
    @Module({ imports: [Plain, { module: Plain, global: true }] })
    class AppModule {}
    await expect(VelaFactory.create(AppModule, { diagnostics: 'throw' })).rejects.toThrow(
      /Plain#default was imported again with a different global flag/,
    );

    // A @Global() class is global in both forms.
    @Global()
    @Module({})
    class AlwaysGlobal {}
    @Module({ imports: [AlwaysGlobal, { module: AlwaysGlobal, global: true }] })
    class GlobalApp {}
    const app = await VelaFactory.create(GlobalApp, { diagnostics: 'throw' });
    await app.close();
  });

  it('reports hand-written definitions that disagree on global', async () => {
    @Module({})
    class HandWritten {}
    @Module({
      imports: [
        { module: HandWritten, key: 'one' },
        { module: HandWritten, key: 'one', global: true },
      ],
    })
    class AppModule {}
    await expect(VelaFactory.create(AppModule, { diagnostics: 'throw' })).rejects.toThrow(
      /HandWritten#one was imported again with a different global flag/,
    );
  });
});

describe('module contract: referenceKey', () => {
  it('keys objects and functions by reference and other values by value', () => {
    const first = driver('a');
    const second = driver('a');
    expect(referenceKey(first)).toBe(referenceKey(first));
    expect(referenceKey(first)).not.toBe(referenceKey(second));
    expect(referenceKey('files', 3)).toBe(referenceKey('files', 3));
    expect(referenceKey('files')).not.toBe(referenceKey('images'));
    const make = (value: string) => () => value;
    expect(referenceKey(make('a'))).not.toBe(referenceKey(make('a')));
    expect(referenceKey(undefined)).toBe(referenceKey(undefined));
    const unique = Symbol('unique');
    expect(referenceKey(unique)).toBe(referenceKey(unique));
    expect(referenceKey(unique)).not.toBe(referenceKey(Symbol('unique')));
    expect(referenceKey(Symbol.for('vela:shared'))).toBe(referenceKey(Symbol.for('vela:shared')));
  });

  it('serves as a spec.key over structural stateful options', () => {
    interface ClientOptions {
      client: object;
      retries?: number;
    }
    const { ConfigurableModuleClass } = defineModule<ClientOptions, 'client'>({
      name: 'Client',
      structural: ['client'],
      key: (options) => referenceKey(options.client),
    });
    class ClientModule extends ConfigurableModuleClass {}
    const client = {};
    expect(ClientModule.forRoot({ client, retries: 1 }).key).toBe(
      ClientModule.forRoot({ client, retries: 2 }).key,
    );
    expect(ClientModule.forRoot({ client: {} }).key).not.toBe(ClientModule.forRoot({ client }).key);
  });
});

describe('module contract: ConfigurableModuleBuilder', () => {
  it('generates Nest register/registerAsync by default', async () => {
    const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = new ConfigurableModuleBuilder<{
      url: string;
    }>({ moduleName: 'Client' }).build();
    @Module({})
    class ClientModule extends ConfigurableModuleClass {}
    expect(typeof Reflect.get(ClientModule, 'register')).toBe('function');
    expect(typeof Reflect.get(ClientModule, 'registerAsync')).toBe('function');
    expect(Reflect.get(ClientModule, 'forRoot')).toBeUndefined();

    @Module({
      imports: [ClientModule.registerAsync({ useFactory: () => ({ url: 'https://a' }) })],
    })
    class AppModule {}
    const app = await VelaFactory.create(AppModule);
    await expect(app.getContainer().resolveAsync(MODULE_OPTIONS_TOKEN)).resolves.toEqual({
      url: 'https://a',
    });
    await app.close();
  });
});

describe('module contract: global lives on @Global and DynamicModule', () => {
  it('keeps @Global in either decorator order', async () => {
    const SHARED = new InjectionToken<string>('module contract shared');
    // Decorators apply bottom-up: @Global() runs before @Module() here.
    @Module({ providers: [defineProvider(SHARED, { useValue: 'x' })], exports: [SHARED] })
    @Global()
    class GlobalAfter {}

    @Module({})
    class Feature {}

    @Module({ imports: [GlobalAfter, Feature] })
    class AppModule {}
    const app = await VelaFactory.create(AppModule, { diagnostics: 'throw' });
    expect(app.getContainer().getOwnerModuleIds(SHARED)).toHaveLength(1);
    const scope = app.getContainer().getResolvedScope(SHARED, 'Feature#default');
    expect(scope).toBeDefined();
    await app.close();
  });
});

describe('module contract: removed authoring paths', () => {
  it('no longer exports the legacy module helpers or the plugin API', () => {
    const removed = [
      'defineConfigurableModule',
      'defineDynamicModule',
      'moduleKey',
      'moduleToken',
      'provideGlobal',
      'definePlugin',
      'composePlugins',
      'PluginRegistry',
      'PluginRootModule',
      'PLUGIN_REGISTRY_TOKEN',
    ];
    expect(removed.filter((name) => name in moduleKit)).toEqual([]);
  });
});
