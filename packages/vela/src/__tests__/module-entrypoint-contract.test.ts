import { describe, expect, expectTypeOf, it } from 'vitest';
import { Container } from '../container/container';
import { DiscoveryService } from '../discovery/discovery.service';
import { EntrypointRegistry } from '../entrypoint/entrypoint.registry';
import { ConfigurableModuleBuilder } from '../module/configurable-module.builder';
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
  const renamed = original.setClassMethodName('register');
  // @ts-expect-error The original branch still exposes forRoot.
  original.build().ConfigurableModuleClass.register({ color: 'red' });
  // @ts-expect-error The renamed branch exposes register, not forRoot.
  renamed.build().ConfigurableModuleClass.forRoot({ color: 'red' });
}
void invalidContracts;

describe('immutable configurable module builder', () => {
  it('preserves every retained method-name branch', () => {
    const original = new ConfigurableModuleBuilder<{ color: string }>({ moduleName: 'Widget' });
    const renamed = original.setClassMethodName('register');
    const sibling = original.setClassMethodName('configure');
    expect(renamed).not.toBe(original);
    expect(original.build().ConfigurableModuleClass.forRoot({ color: 'red' }).module).toBeTypeOf(
      'function',
    );
    expect(renamed.build().ConfigurableModuleClass.register({ color: 'blue' }).module).toBeTypeOf(
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
    const firstModule = first.ConfigurableModuleClass.forRootAsync({ useClass: DefaultFactory });
    const secondModule = second.ConfigurableModuleClass.forRootAsync({ useClass: ChangedFactory });
    const container = new Container();
    for (const provider of [...(firstModule.providers ?? []), ...(secondModule.providers ?? [])])
      container.register(provider);
    expect(await container.resolveAsync(first.MODULE_OPTIONS_TOKEN)).toEqual({ color: 'red' });
    expect(await container.resolveAsync(second.MODULE_OPTIONS_TOKEN)).toEqual({ color: 'blue' });
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
      .ConfigurableModuleClass.forRoot({ color: 'red', isGlobal: true });
    const newResult = changed.build().ConfigurableModuleClass.forRoot({ color: 'red' });
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
