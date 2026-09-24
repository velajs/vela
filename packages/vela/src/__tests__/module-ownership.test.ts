import { describe, expect, it } from 'vitest';
import {
  Controller,
  defineProvider,
  Get,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  VelaFactory,
  forwardRef,
  Scope,
} from '../index';
import { createOpenApiDocument } from '../openapi/index';
import {
  DiscoveryService,
  createDiscoverableDecorator,
  EntrypointRegistry,
  registerEntrypointKind,
  Container,
} from '../module-kit';

describe('module registration ownership', () => {
  it('keeps both keyed controller sets in OpenAPI', () => {
    @Controller('/first')
    class First {
      @Get() get() {
        return 'first';
      }
    }
    @Controller('/second')
    class Second {
      @Get() get() {
        return 'second';
      }
    }
    class Feature {}
    @Module({
      imports: [
        { module: Feature, key: 'one', controllers: [First] },
        { module: Feature, key: 'two', controllers: [Second] },
      ],
    })
    class Root {}
    expect(Object.keys(createOpenApiDocument(Root).paths)).toEqual(['/first', '/second']);
  });

  it('accepts acyclic dependencies between distinct classes with the same name', async () => {
    const Child = class SameName {};
    const Parent = class SameName {};
    Module({})(Child);
    Module({ imports: [Child] })(Parent);
    const app = await VelaFactory.create(Parent);
    expect(
      app
        .getContainer()
        .getModuleDescriptions()
        .filter((entry) => entry.moduleId.startsWith('SameName#')),
    ).toHaveLength(2);
    await app.close();
  });

  it('resolves a legacy filtered discovery hit in the selected owner', async () => {
    @Injectable()
    class Shared {
      label = '';
    }
    @Module({
      providers: [
        defineProvider(Shared, { useValue: Object.assign(new Shared(), { label: 'one' }) }),
      ],
    })
    class One {}
    @Module({
      providers: [
        defineProvider(Shared, { useValue: Object.assign(new Shared(), { label: 'two' }) }),
      ],
    })
    class Two {}
    @Module({ imports: [One, Two] })
    class Root {}
    const app = await VelaFactory.create(Root);
    const hit = app
      .get(DiscoveryService)
      .getProviders({ moduleId: 'Two#default' })
      .find((entry) => entry.token === Shared);
    expect(hit?.instance).toMatchObject({ label: 'two' });
    await app.close();
  });

  it('initializes every owned singleton once using its own options', async () => {
    const options = new InjectionToken<string>('owned options');
    const initialized: string[] = [];
    @Injectable()
    class Shared {
      constructor(@Inject(options) readonly name: string) {}
      onModuleInit() {
        initialized.push(this.name);
      }
    }
    class Feature {}
    @Module({
      imports: ['one', 'two'].map((key) => ({
        module: Feature,
        key,
        providers: [defineProvider(options, { useValue: key }), Shared],
      })),
    })
    class Root {}
    const app = await VelaFactory.create(Root);
    expect(initialized).toEqual(['one', 'two']);
    await app.close();
  });

  it('walks distinct keyed imports and forward-reference diamonds', () => {
    @Controller('/nested')
    class Nested {
      @Get() get() {
        return 'nested';
      }
    }
    @Module({ controllers: [Nested] })
    class Leaf {}
    class Feature {}
    const second = { module: Feature, key: 'two', imports: [Leaf] };
    @Module({ imports: [{ module: Feature, key: 'one' }, forwardRef(() => second), second] })
    class Root {}
    expect(Object.keys(createOpenApiDocument(Root).paths)).toEqual(['/nested']);
  });

  it('enumerates metadata per owner without constructing singleton or request providers', () => {
    let constructed = 0;
    const Marker = createDiscoverableDecorator<{ role: string }>('test:ownership:marker');
    const Method = createDiscoverableDecorator<{ operation: string }>('test:ownership:method');
    const Appended = createDiscoverableDecorator<{ operation: string }>('test:ownership:appended', {
      append: true,
    });
    @Marker({ role: 'worker' })
    @Injectable()
    class Shared {
      constructor() {
        constructed++;
      }
      @Method({ operation: 'read' }) read() {}
      @Appended({ operation: 'write' }) write() {}
    }
    const container = new Container();
    container.register(Shared, 'one');
    container.register(defineProvider(Shared, { useClass: Shared, scope: Scope.REQUEST }), 'two');
    const discovery = new DiscoveryService(container);
    expect(
      discovery
        .getRegistrations({ metadataOnly: true })
        .map((entry) => [entry.moduleId, entry.scope]),
    ).toEqual([
      ['one', Scope.DEFAULT],
      ['two', Scope.REQUEST],
    ]);
    expect(
      discovery
        .registrationsWithMeta(Marker, { metadataOnly: true, moduleId: 'two' })
        .map((entry) => entry.moduleId),
    ).toEqual(['two']);
    for (const decorator of [Method, Appended]) {
      const hits = discovery.registeredMethodsWithMeta(decorator, { metadataOnly: true });
      expect(hits.map((hit) => hit.class.moduleId)).toEqual(['one', 'two']);
      expect(hits.every((hit) => hit.class.instance === undefined)).toBe(true);
      expect(discovery.methodsWithMeta(decorator, { metadataOnly: true })).toHaveLength(1);
    }
    expect(constructed).toBe(0);
  });

  it('keeps eager and lazy owners distinct in metadata-only entrypoint snapshots', async () => {
    const Marker = createDiscoverableDecorator<{ source: string }>('test:ownership:entry');
    registerEntrypointKind({ kind: 'test:ownership:entry', metaKey: Marker.KEY, level: 'class' });
    const Method = createDiscoverableDecorator<{ source: string }>('test:ownership:entry-method');
    registerEntrypointKind({
      kind: 'test:ownership:entry-method',
      metaKey: Method.KEY,
      level: 'method',
    });
    const initialized: string[] = [];
    const NAME = new InjectionToken<string>('entrypoint owner');
    @Marker({ source: 'test' })
    @Injectable()
    class Shared {
      constructor(@Inject(NAME) readonly name: string) {}
      onModuleInit() {
        initialized.push(this.name);
      }
      @Method({ source: 'method' }) run() {
        return this.name;
      }
    }
    class Feature {}
    @Module({
      imports: ['eager', 'lazy'].map((key) => ({
        module: Feature,
        key,
        lazy: key === 'lazy',
        providers: [defineProvider(NAME, { useValue: key }), Shared],
      })),
    })
    class Root {}
    const app = await VelaFactory.create(Root);
    expect(initialized).toEqual(['eager']);
    const entries = app.entrypoints.ofKind('test:ownership:entry');
    expect(entries.map((entry) => entry.moduleId)).toEqual(['Feature#eager', 'Feature#lazy']);
    expect(entries[0]!.instance).toMatchObject({ name: 'eager' });
    expect(entries[1]!.instance).toBeUndefined();
    expect(
      app.entrypoints.ofKind('test:ownership:entry-method').map((entry) => entry.moduleId),
    ).toEqual(['Feature#eager', 'Feature#lazy']);
    const late = await app.getContainer().resolveAsync(Shared, entries[1]!.moduleId);
    expect(late.name).toBe('lazy');
    expect(initialized).toEqual(['eager', 'lazy']);
    await app.close();
  });

  it('resolves owner-bearing request entrypoints per application and invocation', async () => {
    const Marker = createDiscoverableDecorator<{ role: string }>('test:ownership:request');
    registerEntrypointKind({ kind: 'test:ownership:request', metaKey: Marker.KEY, level: 'class' });
    let constructed = 0;
    const NAME = new InjectionToken<string>('request owner');
    @Marker({ role: 'request' })
    @Injectable({ scope: Scope.REQUEST })
    class Shared {
      readonly instanceId = ++constructed;
      constructor(@Inject(NAME) readonly name: string) {}
    }
    class Feature {}
    const root = (appName: string) => {
      @Module({
        imports: ['one', 'two'].map((key) => ({
          module: Feature,
          key,
          providers: [defineProvider(NAME, { useValue: `${appName}:${key}` }), Shared],
        })),
      })
      class Root {}
      return Root;
    };
    const apps = await Promise.all([VelaFactory.create(root('A')), VelaFactory.create(root('B'))]);
    expect(constructed).toBe(0);
    const results = await Promise.all(
      apps.flatMap((app) =>
        [1, 2].map(async () => {
          const scope = app.getContainer().createChild();
          const values = await Promise.all(
            app.entrypoints
              .ofKind('test:ownership:request')
              .map((entry) => scope.resolveAsync(Shared, entry.moduleId)),
          );
          await scope.dispose();
          return values;
        }),
      ),
    );
    expect(results.map((values) => values.map((value) => value.name))).toEqual([
      ['A:one', 'A:two'],
      ['A:one', 'A:two'],
      ['B:one', 'B:two'],
      ['B:one', 'B:two'],
    ]);
    expect(new Set(results.flat().map((value) => value.instanceId)).size).toBe(8);
    await Promise.all(apps.map((app) => app.close()));
  });

  it('retains ownerless computed contributions for 1.x compatibility', async () => {
    const registry = await EntrypointRegistry.build(new DiscoveryService(new Container()), [
      {
        collectEntrypoints: () => [
          { kind: 'legacy', token: 'legacy', instance: undefined, meta: {} },
        ],
      },
    ]);
    expect(registry.ofKind('legacy')[0]!.moduleId).toBeUndefined();
  });
});
