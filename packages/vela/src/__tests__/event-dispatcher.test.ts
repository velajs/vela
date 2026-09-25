import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Inject, Injectable } from '../container/decorators';
import { InjectionToken, defineProvider } from '../container/types';
import { Scope } from '../constants';
import { Module } from '../module';
import { VelaFactory } from '../factory';
import { MetadataRegistry } from '../registry/metadata.registry';
import { createExecutionScope } from '../entrypoint/execution-scope';
import {
  EventEmitterModule,
  EventEmitter,
  EventDispatcher,
  defineEvent,
  defineEventVocabulary,
  OnEvent,
} from '../event-emitter';
import { SchemaValidationError } from '../validation/standard-schema';

beforeEach(() => {
  MetadataRegistry.setModuleOptions(EventEmitterModule, {
    lazy: true,
    providers: [EventEmitter, EventDispatcher],
    exports: [EventEmitter, EventDispatcher],
  });
});

const events = defineEventVocabulary({
  'account.created': z.object({ id: z.string().transform(Number) }),
  tick: z.number(),
});

describe('scoped event dispatch', () => {
  it('validates transformed input once and defers construction of scoped listeners', async () => {
    const validate = vi.fn(async (s: string) => {
      await Promise.resolve();
      return Number(s);
    });
    const event = defineEvent('counted', z.string().transform(validate));
    const seen: number[] = [];
    let constructed = 0;
    @Injectable({ scope: Scope.REQUEST })
    class Listener {
      readonly #suffix = 1;
      constructor() {
        constructed++;
      }
      @OnEvent(event)
      onEvent(payload: number) {
        seen.push(payload + this.#suffix);
      }
    }
    @Module({ imports: [EventEmitterModule], providers: [Listener] })
    class App {}
    const app = await VelaFactory.create(App);
    const dispatcher = app.get(EventDispatcher);
    expect(constructed).toBe(0);
    await dispatcher.emit(event, '41');
    expect(seen).toEqual([42]);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(constructed).toBe(1);
    await dispatcher.emit(event, '42');
    expect(constructed).toBe(2);
    await app.dispose();
  });

  it('keeps tenant providers per scope and rejects foreign or finished scopes', async () => {
    const tenant = new InjectionToken<string>('event-tenant');
    const seen: string[] = [];
    @Injectable({ scope: Scope.REQUEST })
    class Listener {
      readonly #tenant: string;
      constructor(@Inject(tenant) id: string) {
        this.#tenant = id;
      }
      @OnEvent(events.tick)
      async onTick(value: number) {
        await Promise.resolve();
        seen.push(`${this.#tenant}:${value}`);
      }
    }
    @Module({
      imports: [EventEmitterModule],
      providers: [
        Listener,
        defineProvider(tenant, {
          scope: Scope.REQUEST,
          inject: [],
          useFactory: () => {
            throw Error('tenant required');
          },
        }),
      ],
    })
    class App {}
    const app = await VelaFactory.create(App);
    const other = await VelaFactory.create(App);
    const dispatcher = app.get(EventDispatcher);
    const a = createExecutionScope(app.getContainer());
    const b = createExecutionScope(app.getContainer());
    const foreign = createExecutionScope(other.getContainer());
    a.container.setRequestInstance(tenant, 'a');
    b.container.setRequestInstance(tenant, 'b');
    const bound = dispatcher.inScope(a.container);
    await Promise.all([
      bound.emit(events.tick, 1),
      dispatcher.inScope(b.container).emit(events.tick, 2),
    ]);
    expect(seen.toSorted()).toEqual(['a:1', 'b:2']);
    expect(() => dispatcher.inScope(foreign.container)).toThrow('this application');
    expect(() => dispatcher.inScope(app.getContainer())).toThrow('active execution scope');
    await Promise.all([a.finish(), b.finish(), foreign.finish()]);
    await expect(bound.emit(events.tick, 3)).rejects.toThrow('finished');
    expect(() => bound.defer(events.tick, 3)).toThrow('finished');
    await Promise.all([app.dispose(), other.dispose()]);
  });

  it('settles every listener and disposes scoped dependencies after deferred completion', async () => {
    const log: string[] = [];
    const failure = Error('failed listener');
    @Injectable({ scope: Scope.REQUEST })
    class Listener {
      @OnEvent(events.tick)
      async onTick() {
        await Promise.resolve();
        log.push('delivered');
        throw failure;
      }
      dispose() {
        log.push('disposed');
      }
    }
    @Injectable({ scope: Scope.REQUEST })
    class Sibling {
      @OnEvent(events.tick)
      async onTick() {
        await Promise.resolve();
        log.push('sibling');
      }
    }
    @Module({ imports: [EventEmitterModule], providers: [Listener, Sibling] })
    class App {}
    const app = await VelaFactory.create(App);
    const scope = createExecutionScope(app.getContainer());
    app.get(EventDispatcher).inScope(scope.container).defer(events.tick, 1);
    expect(log).toEqual([]);
    await expect(scope.finish()).rejects.toBe(failure);
    expect(log.slice(0, 2).toSorted()).toEqual(['delivered', 'sibling']);
    expect(log[2]).toBe('disposed');
    await app.dispose();
  });

  it('rejects invalid external payloads and conflicting contracts before constructing listeners', async () => {
    let constructed = 0;
    @Injectable({ scope: Scope.REQUEST })
    class Listener {
      constructor() {
        constructed++;
      }
      @OnEvent(events['account.created'])
      onEvent(_payload: { id: number }) {}
    }
    @Module({ imports: [EventEmitterModule], providers: [Listener] })
    class App {}
    const app = await VelaFactory.create(App);
    const dispatcher = app.get(EventDispatcher);
    const scope = createExecutionScope(app.getContainer());
    await expect(
      dispatcher.inScope(scope.container).emitUnknown(events['account.created'], { id: 1 }),
    ).rejects.toBeInstanceOf(SchemaValidationError);
    await expect(
      dispatcher.emit(defineEvent('account.created', z.string()), 'wrong contract'),
    ).rejects.toThrow('Conflicting schemas');
    expect(constructed).toBe(0);
    await scope.finish();
    await app.dispose();
  });

  it('validates async schema input even without listeners and isolates validation failures', async () => {
    const schema = z
      .string()
      .refine(async (s) => s.length > 1)
      .transform((s) => s.length);
    const event = defineEvent('async', schema);
    @Module({ imports: [EventEmitterModule] })
    class App {}
    const app = await VelaFactory.create(App);
    await expect(app.get(EventDispatcher).emit(event, '')).rejects.toBeInstanceOf(
      SchemaValidationError,
    );
    await expect(app.get(EventDispatcher).emit(event, 'ok')).resolves.toBeUndefined();
    await app.dispose();
  });
});

describe('decorated event scopes', () => {
  it('resolves an effectively request-scoped listener for every emission', async () => {
    let nextId = 0;
    const disposed: number[] = [];
    const seen: number[] = [];
    @Injectable({ scope: Scope.REQUEST })
    class Dependency {
      readonly id = ++nextId;
      dispose() {
        disposed.push(this.id);
      }
    }
    @Injectable()
    class Listener {
      readonly #dependency: Dependency;
      constructor(@Inject(Dependency) dependency: Dependency) {
        this.#dependency = dependency;
      }
      @OnEvent(events.tick)
      async onEvent() {
        await Promise.resolve();
        seen.push(this.#dependency.id);
      }
    }
    @Module({ imports: [EventEmitterModule], providers: [Listener, Dependency] })
    class App {}
    const app = await VelaFactory.create(App);
    const emitter = app.get(EventDispatcher);
    expect(nextId).toBe(0);
    await Promise.all([emitter.emit(events.tick, 1), emitter.emit(events.tick, 1)]);
    expect(seen.toSorted()).toEqual([1, 2]);
    expect(disposed.toSorted()).toEqual([1, 2]);
    await app.dispose();
  });

  it('resolves the same listener token in each owning module', async () => {
    const label = new InjectionToken<string>('owner-label');
    const seen: string[] = [];
    @Injectable({ scope: Scope.REQUEST })
    class Listener {
      readonly #label: string;
      constructor(@Inject(label) value: string) {
        this.#label = value;
      }
      @OnEvent(events.tick)
      onScoped() {
        seen.push(this.#label);
      }
    }
    @Module({})
    class Feature {}
    const feature = (key: string) => ({
      module: Feature,
      key,
      providers: [Listener, defineProvider(label, { useValue: key })],
    });
    @Module({ imports: [EventEmitterModule, feature('a'), feature('b')] })
    class App {}
    const app = await VelaFactory.create(App);
    await app.get(EventDispatcher).emit(events.tick, 1);
    expect(seen.toSorted()).toEqual(['a', 'b']);
    await app.dispose();
  });
});

describe('event invocation boundaries', () => {
  it('materializes an async lazy listener dependency at dispatch', async () => {
    const value = new InjectionToken<number>('async-event-value');
    let factories = 0;
    let seen = 0;
    @Injectable({ scope: Scope.REQUEST })
    class Listener {
      readonly #value: number;
      constructor(@Inject(value) resolved: number) {
        this.#value = resolved;
      }
      @OnEvent(events.tick)
      onEvent(payload: number) {
        seen = this.#value + payload;
      }
    }
    @Module({
      lazy: true,
      providers: [
        Listener,
        defineProvider(value, {
          scope: Scope.REQUEST,
          inject: [],
          useFactory: async () => {
            factories++;
            return 40;
          },
        }),
      ],
    })
    class LazyFeature {}
    @Module({ imports: [EventEmitterModule, LazyFeature] })
    class App {}
    const app = await VelaFactory.create(App);
    const dispatcher = app.get(EventDispatcher);
    expect(factories).toBe(0);
    await dispatcher.emit(events.tick, 2);
    expect(seen).toBe(42);
    expect(factories).toBe(1);
    await app.dispose();
  });

  it('rejects an aborted invocation before validation and reports multiple listener failures', async () => {
    const one = Error('one');
    const two = Error('two');
    let calls = 0;
    @Injectable({ scope: Scope.REQUEST })
    class Listener {
      @OnEvent(events.tick)
      one() {
        calls++;
        throw one;
      }
      @OnEvent(events.tick)
      two() {
        calls++;
        throw two;
      }
    }
    @Module({ imports: [EventEmitterModule], providers: [Listener] })
    class App {}
    const app = await VelaFactory.create(App);
    const dispatcher = app.get(EventDispatcher);
    const controller = new AbortController();
    const scope = createExecutionScope(app.getContainer(), { signal: controller.signal });
    controller.abort();
    await expect(dispatcher.inScope(scope.container).emit(events.tick, 1)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(calls).toBe(0);
    await scope.finish();
    await expect(dispatcher.emit(events.tick, 1)).rejects.toMatchObject({ errors: [one, two] });
    expect(calls).toBe(2);
    await app.dispose();
  });
});
