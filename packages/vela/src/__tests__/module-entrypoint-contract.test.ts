import { describe, expect, expectTypeOf, it } from 'vitest';
import { InjectionToken } from '../container/types';
import { defineModule } from '../module/define-module';
import { Container } from '../container/container';
import { createDiscoverableDecorator } from '../discovery/discoverable.decorator';
import { DiscoveryService } from '../discovery/discovery.service';
import { EntrypointRegistry } from '../entrypoint/entrypoint.registry';
import { ConfigurableModuleBuilder } from '../module/configurable-module.builder';
import { Module } from '../module/decorators';
import { VelaFactory } from '../factory';
import { readProcessorMetadata } from '../queue/queue.decorators';
import { readWsEntrypointMeta } from '../websocket/ws-dispatcher';

function invalidContracts(registry: EntrypointRegistry): void {
  // @ts-expect-error String-only lookups cannot invent the metadata shape.
  registry.ofKind<{ count: number }>('count');
  // @ts-expect-error An explicit result requires a parser that produces that result.
  registry.ofKind<number>('count', (value) => value);
  // @ts-expect-error A method-name type cannot replace the runtime transition.
  new ConfigurableModuleBuilder<{ color: string }, 'register'>();
  const original = new ConfigurableModuleBuilder<{ color: string }>();
  const renamed = original.setClassMethodName('forRoot');
  // @ts-expect-error The original branch exposes Nest's register, not forRoot.
  original.build().ConfigurableModuleClass.forRoot({ color: 'red' });
  // @ts-expect-error The renamed branch exposes forRoot, not register.
  renamed.build().ConfigurableModuleClass.register({ color: 'red' });
}
void invalidContracts;

describe('immutable configurable module builder', () => {
  it('preserves every retained method-name branch', () => {
    const original = new ConfigurableModuleBuilder<{ color: string }>({ moduleName: 'Widget' });
    const renamed = original.setClassMethodName('forRoot');
    const sibling = original.setClassMethodName('configure');
    expect(renamed).not.toBe(original);
    expect(original.build().ConfigurableModuleClass.register({ color: 'red' }).module).toBeTypeOf(
      'function',
    );
    expect(renamed.build().ConfigurableModuleClass.forRoot({ color: 'blue' }).module).toBeTypeOf(
      'function',
    );
    expect(sibling.build().ConfigurableModuleClass.configure({ color: 'green' }).module).toBeTypeOf(
      'function',
    );
  });

  it('preserves factory-method branches when resolving asynchronous options', async () => {
    const original = new ConfigurableModuleBuilder<{ color: string }>();
    const changed = original.setFactoryMethodName('make');
    class DefaultFactory {
      create() {
        return { color: 'red' };
      }
    }
    class ChangedFactory {
      make() {
        return { color: 'blue' };
      }
    }
    const first = original.build();
    const second = changed.build();
    @Module({
      imports: [
        first.ConfigurableModuleClass.registerAsync({ useClass: DefaultFactory }),
        second.ConfigurableModuleClass.registerAsync({ useClass: ChangedFactory }),
      ],
    })
    class OptionsHost {}
    const app = await VelaFactory.create(OptionsHost);
    expect(app.get(first.MODULE_OPTIONS_TOKEN)).toEqual({ color: 'red' });
    expect(app.get(second.MODULE_OPTIONS_TOKEN)).toEqual({ color: 'blue' });
    await app.close();
  });

  it('copies extras into a new branch without changing older transformations', () => {
    const original = new ConfigurableModuleBuilder<{ color: string }>();
    const defaults = { tag: 'original' };
    const changed = original.setExtras(defaults, (definition, extras) => ({
      ...definition,
      key: extras.tag,
    }));
    defaults.tag = 'mutated';
    const oldResult = original
      .build()
      .ConfigurableModuleClass.register({ color: 'red', isGlobal: true });
    const newResult = changed.build().ConfigurableModuleClass.register({ color: 'red' });
    expect(oldResult.global).toBe(true);
    expect(newResult.key).toBe('original');
    expect(newResult.global).toBeUndefined();
  });
});

describe('entrypoint metadata evidence', () => {
  it('returns unknown metadata until an actual parser validates it', async () => {
    const discovery = new DiscoveryService(new Container());
    const registry = await EntrypointRegistry.build(discovery, [
      {
        collectEntrypoints: () => [
          { kind: 'queue', token: 'processor', instance: undefined, meta: { queueName: 'jobs' } },
        ],
      },
    ]);
    expectTypeOf(registry.ofKind('queue')[0]!.meta).toEqualTypeOf<unknown>();
    const decoded = registry.ofKind('queue', readProcessorMetadata);
    expectTypeOf(decoded[0]!.meta).toEqualTypeOf<{ queueName: string }>();
    expect(decoded[0]!.meta.queueName).toBe('jobs');
    registry.ofKind('queue').pop();
    expect(registry.ofKind('queue')).toHaveLength(1);
  });

  it('rejects malformed metadata before dispatch', async () => {
    const registry = await EntrypointRegistry.build(new DiscoveryService(new Container()), [
      {
        collectEntrypoints: () => [
          { kind: 'queue', token: 'processor', instance: undefined, meta: { queueName: 42 } },
        ],
      },
    ]);
    expect(() => registry.ofKind('queue', readProcessorMetadata)).toThrow(
      'queueName must be a string',
    );
    expect(() => readWsEntrypointMeta({ path: '/socket', dispatcher: {} })).toThrow(
      'Invalid WebSocket entrypoint',
    );
  });
});

function configurableAuthoringTypes(): void {
  const COUNT = new InjectionToken<number>('count');
  const {
    ConfigurableModuleClass: Feature,
    OPTIONS_TYPE,
    ASYNC_OPTIONS_TYPE,
  } = defineModule<{ color: string; size?: number }, 'size'>({
    name: 'TypedFeature',
    structural: ['size'],
  });
  Feature.forRoot({ color: 'red', lazy: true });
  Feature.forRootAsync({
    inject: [COUNT],
    size: 7,
    lazy: true,
    useFactory: (count) => {
      expectTypeOf(count).toEqualTypeOf<number>();
      return { color: String(count) };
    },
  });
  const sync: typeof OPTIONS_TYPE = { color: 'red', lazy: true };
  const asyncOptions: typeof ASYNC_OPTIONS_TYPE = {
    inject: [],
    size: 4,
    lazy: true,
    useFactory: () => ({ color: 'red' }),
  };
  void sync;
  void asyncOptions;
  // @ts-expect-error Registration laziness is boolean.
  Feature.forRoot({ color: 'red', lazy: 'yes' });
  // @ts-expect-error Structural fields retain their option type.
  Feature.forRootAsync({ inject: [], size: 'big', useFactory: () => ({ color: 'red' }) });
  // @ts-expect-error Misspelled structural fields are rejected.
  Feature.forRootAsync({ inject: [], colour: 'red', useFactory: () => ({ color: 'red' }) });
  // @ts-expect-error Factory results still satisfy all required non-structural options.
  Feature.forRootAsync({ inject: [], useFactory: () => ({}) });
  // @ts-expect-error Non-structural options come from the factory, not the call site.
  Feature.forRootAsync({ inject: [], color: 'red', useFactory: () => ({ color: 'red' }) });
  // @ts-expect-error Factory choices remain exclusive.
  Feature.forRootAsync({
    inject: [],
    useFactory: () => ({ color: 'red' }),
    useClass: class {
      create() {
        return { color: 'red' };
      }
    },
  });
}
void configurableAuthoringTypes;

function registrationDiscoveryTypes(discovery: DiscoveryService): void {
  const Marker = createDiscoverableDecorator<{ queue: string }>('typed:module:marker');
  const registration = discovery.registrationsWithMeta(Marker, { metadataOnly: true })[0]!;
  expectTypeOf(registration.moduleId).toEqualTypeOf<string>();
  expectTypeOf(registration.meta.queue).toEqualTypeOf<string>();
  const method = discovery.registeredMethodsWithMeta(Marker)[0]!;
  expectTypeOf(method.class.moduleId).toEqualTypeOf<string>();
  expectTypeOf(method.meta.queue).toEqualTypeOf<string>();
  expectTypeOf(discovery.registeredMethodsWithMeta('untyped')[0]!.meta).toEqualTypeOf<unknown>();
}
void registrationDiscoveryTypes;
