import { beforeEach, describe, expect, it } from 'vitest';
import {
  Inject,
  Injectable,
  InjectionToken,
  MetadataRegistry,
  Module,
  PLUGIN_REGISTRY_TOKEN,
  PluginRegistry,
  VelaFactory,
  composePlugins,
  definePlugin,
} from '../index.js';
import type { DynamicModule } from '../index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('Plugin manifest', () => {
  it('definePlugin freezes the manifest', () => {
    @Module({})
    class M {}
    const p = definePlugin({ id: 'a', version: '1.0.0', module: M });
    expect(Object.isFrozen(p)).toBe(true);
    expect(() => {
      (p as { id: string }).id = 'b';
    }).toThrow();
  });

  it('definePlugin requires id, version, module', () => {
    @Module({})
    class M {}
    expect(() =>
      definePlugin({ id: '', version: '1.0.0', module: M } as never),
    ).toThrow(/id/);
    expect(() =>
      definePlugin({ id: 'a', version: '', module: M } as never),
    ).toThrow(/version/);
    expect(() =>
      definePlugin({ id: 'a', version: '1.0.0', module: undefined as never }),
    ).toThrow(/module/);
  });

  it('composePlugins orders dependencies before dependents (topological)', () => {
    @Module({})
    class A {}
    @Module({})
    class B {}
    @Module({})
    class C {}

    const a = definePlugin({ id: 'a', version: '1.0.0', module: A });
    const b = definePlugin({
      id: 'b',
      version: '1.0.0',
      module: B,
      dependsOn: ['a'],
    });
    const c = definePlugin({
      id: 'c',
      version: '1.0.0',
      module: C,
      dependsOn: ['b'],
    });

    // Pass in reverse order — composer should still order them a, b, c
    const composed = composePlugins([c, b, a]);
    const imports = composed.imports as Array<{ name?: string }> | undefined;
    expect(imports?.[0]).toBe(A);
    expect(imports?.[1]).toBe(B);
    expect(imports?.[2]).toBe(C);
  });

  it('composePlugins detects cycles', () => {
    @Module({})
    class A {}
    @Module({})
    class B {}

    const a = definePlugin({
      id: 'a',
      version: '1.0.0',
      module: A,
      dependsOn: ['b'],
    });
    const b = definePlugin({
      id: 'b',
      version: '1.0.0',
      module: B,
      dependsOn: ['a'],
    });

    expect(() => composePlugins([a, b])).toThrow(/cycle/i);
  });

  it('composePlugins detects missing dependency', () => {
    @Module({})
    class A {}
    const a = definePlugin({
      id: 'a',
      version: '1.0.0',
      module: A,
      dependsOn: ['missing'],
    });
    expect(() => composePlugins([a])).toThrow(/missing/);
  });

  it('PluginRegistry exposes list/get/dependents', () => {
    @Module({})
    class A {}
    @Module({})
    class B {}

    const a = definePlugin({ id: 'a', version: '1.0.0', module: A });
    const b = definePlugin({
      id: 'b',
      version: '1.0.0',
      module: B,
      dependsOn: ['a'],
    });

    const reg = new PluginRegistry([a, b]);
    expect(reg.list()).toHaveLength(2);
    expect(reg.get('a')).toBe(a);
    expect(reg.get('missing')).toBeUndefined();
    expect(reg.dependents('a')).toEqual([b]);
    expect(reg.dependents('b')).toEqual([]);
  });

  it('integration: bootstrap with composePlugins makes PluginRegistry resolvable everywhere', async () => {
    const TOKEN_A = new InjectionToken<string>('TOK_A');

    @Module({
      providers: [{ provide: TOKEN_A, useValue: 'from-a' }],
      exports: [TOKEN_A],
    })
    class APlugin {}

    @Injectable()
    class BService {
      constructor(
        @Inject(PLUGIN_REGISTRY_TOKEN) public registry: PluginRegistry,
      ) {}
    }

    @Module({ providers: [BService] })
    class BPlugin {}

    const a = definePlugin({ id: 'a', version: '1.0.0', module: APlugin });
    const b = definePlugin({
      id: 'b',
      version: '1.0.0',
      module: BPlugin,
      dependsOn: ['a'],
    });

    const composed = composePlugins([a, b]);

    @Module({ imports: [composed as DynamicModule] })
    class App {}

    const app = await VelaFactory.create(App);
    const reg = app.get(PLUGIN_REGISTRY_TOKEN);
    expect(reg).toBeInstanceOf(PluginRegistry);
    expect(reg.list().map((p) => p.id)).toEqual(['a', 'b']);

    // BService can inject the registry from any module thanks to global: true
    const b2 = app.get(BService);
    expect(b2.registry.get('a')?.version).toBe('1.0.0');
  });
});
