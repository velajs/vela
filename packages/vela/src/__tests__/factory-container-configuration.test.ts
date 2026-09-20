import { defineProvider } from '../container/types';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  Inject,
  Injectable,
  InjectionToken,
  MetadataRegistry,
  Module,
  VelaFactory,
} from '../index';
import { bootstrap } from '../factory/bootstrap';

beforeEach(() => MetadataRegistry.clear());

describe('container configuration before bootstrap', () => {
  it('awaits the bootstrap hook before loading the module graph', async () => {
    const platform = new InjectionToken<string>('platform');
    @Module({})
    class App {}

    const { container } = await bootstrap(App, {
      async configureContainer(container) {
        expect(container.getModuleDescriptions().map((module) => module.moduleId)).toEqual([
          '__root__',
        ]);
        await Promise.resolve();
        container.register(defineProvider(platform, { useValue: 'ready' }));
      },
    });

    expect(container.resolve(platform)).toBe('ready');
    expect(container.getModuleDescriptions().map((module) => module.moduleId)).toContain(
      'App#default',
    );
  });

  it('runs adapters in order, then application configuration, before construction and lifecycle', async () => {
    const platform = new InjectionToken<string>('platform');
    const events: string[] = [];

    @Injectable()
    class Service {
      constructor(@Inject(platform) readonly value: string) {
        events.push(`construct:${value}`);
      }

      onModuleInit() {
        events.push(`init:${this.value}`);
      }
    }

    @Module({ providers: [Service] })
    class App {}

    const app = await VelaFactory.create(App, {
      adapters: [
        {
          name: 'first',
          async configureContainer(container) {
            events.push('first:start');
            await Promise.resolve();
            container.register(defineProvider(platform, { useValue: 'first' }));
            container.markGlobalToken(platform);
            events.push('first:end');
          },
          onBootstrap() {
            events.push('bootstrapped');
          },
        },
        {
          name: 'second',
          configureContainer(container) {
            events.push(`second:${container.resolve(platform)}`);
            container.register(defineProvider(platform, { useValue: 'second' }));
          },
        },
      ],
      configureContainer(container) {
        events.push(`application:${container.resolve(platform)}`);
        container.register(defineProvider(platform, { useValue: 'application' }));
      },
    });

    expect(app.get(Service).value).toBe('application');
    expect(events).toEqual([
      'first:start',
      'first:end',
      'second:first',
      'application:second',
      'construct:application',
      'init:application',
      'bootstrapped',
    ]);
  });

  it('stops on a rejected hook without constructing providers or contaminating another application', async () => {
    const platform = new InjectionToken<string>('platform');
    const events: string[] = [];
    const failure = new Error('platform unavailable');

    @Injectable()
    class Service {
      constructor() {
        events.push('construct');
      }
    }

    @Module({ providers: [Service] })
    class App {}

    await expect(
      VelaFactory.create(App, {
        adapters: [
          {
            name: 'failed',
            async configureContainer(container) {
              container.register(defineProvider(platform, { useValue: 'partial' }));
              await Promise.resolve();
              throw failure;
            },
          },
          {
            name: 'skipped',
            configureContainer: () => {
              events.push('adapter');
            },
          },
        ],
        configureContainer: () => {
          events.push('application');
        },
      }),
    ).rejects.toBe(failure);

    expect(events).toEqual([]);
    const app = await VelaFactory.create(App, {
      configureContainer(container) {
        expect(container.has(platform)).toBe(false);
      },
    });
    expect(app.get(Service)).toBeInstanceOf(Service);
    expect(events).toEqual(['construct']);
  });
});
