import { describe, expect, it, vi } from 'vitest';
import {
  Scope,
  defineProvider,
  Controller,
  Head,
  Injectable,
  Module,
  VelaFactory,
} from '@velajs/vela';
import { Container, DiscoveryService } from '@velajs/vela/module-kit';
import type { ContributesEntrypoints, RouteDescription } from '@velajs/vela/module-kit';
import { parseStudioRpcResponse } from '@velajs/studio-protocol';
import {
  StudioAppHolder,
  StudioModule,
  collectModules,
  collectRoutes,
  studioRuntimeAdapter,
} from '../src';
import { diagnosticSnapshot } from '../src/introspect/snapshot';

describe('bounded diagnostic snapshots', () => {
  it('makes bigint, cycles and non-JSON primitives serializable without mislabeling aliases', () => {
    const shared = { value: 1n };
    const input: Record<string, unknown> = {
      first: shared,
      second: shared,
      missing: undefined,
      invalid: NaN,
      fn: () => 1,
      symbol: Symbol('hidden'),
    };
    input.self = input;
    const snapshot = diagnosticSnapshot(input);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual({
      first: { value: '1n' },
      second: { value: '1n' },
      self: '[circular]',
      missing: '[undefined]',
      invalid: '[NaN]',
      fn: '[function]',
      symbol: '[symbol]',
    });
  });

  it('does not invoke getters or toJSON, or enumerate private implementation objects', () => {
    const getter = vi.fn(() => {
      throw new Error('must not run');
    });
    class Secret {
      #key = 'private-secret';
      visible = 'also-internal';
      toJSON() {
        return this.#key;
      }
    }
    const input = Object.defineProperty({ instance: new Secret(), toJSON: getter }, 'secret', {
      get: getter,
      enumerable: true,
    });
    const array = Object.defineProperty([], '0', { get: getter, enumerable: true });
    expect(diagnosticSnapshot(input)).toEqual({
      instance: '[instance]',
      toJSON: '[function]',
      secret: '[accessor]',
    });
    expect(diagnosticSnapshot(array)).toEqual(['[accessor]']);
    expect(getter).not.toHaveBeenCalled();
    expect(
      diagnosticSnapshot(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error('broken');
            },
          },
        ),
      ),
    ).toBe('[unavailable]');
  });

  it('bounds deep, wide and large string metadata and preserves hostile property names safely', () => {
    let deep: unknown = 'end';
    for (let i = 0; i < 100; i++) deep = { next: deep };
    const snapshot = diagnosticSnapshot({ deep, wide: Array(10_000).fill('x'.repeat(10_000)) });
    const json = JSON.stringify(snapshot);
    expect(json).toContain('[truncated]');
    expect(json.length).toBeLessThan(32_000);
    const hostile: unknown = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(JSON.stringify(diagnosticSnapshot(hostile))).toBe('{"__proto__":{"polluted":true}}');
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  it('does not return live references', () => {
    const input = { tags: ['one'] };
    const first = diagnosticSnapshot(input);
    input.tags.push('two');
    expect(first).toEqual({ tags: ['one'] });
    expect(diagnosticSnapshot(input)).toEqual({ tags: ['one', 'two'] });
  });

  it('serves safe metadata through the authenticated RPC envelope', async () => {
    const metadata: Record<string, unknown> = { count: 9n };
    metadata.self = metadata;
    @Injectable()
    class DiagnosticEntrypoints implements ContributesEntrypoints {
      collectEntrypoints() {
        return [
          {
            kind: 'diagnostic-fixture',
            moduleId: 'diagnostic-fixture',
            token: DiagnosticEntrypoints,
            instance: this,
            meta: metadata,
          },
        ];
      }
    }
    @Module({
      imports: [StudioModule.forRoot({ token: 'diagnostic-token' })],
      providers: [DiagnosticEntrypoints],
    })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      const response = await app.getHonoApp().request('/_vela/admin/rpc/app.entrypoints', {
        method: 'POST',
        headers: { authorization: 'Bearer diagnostic-token', 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(200);
      const value = parseStudioRpcResponse('app.entrypoints', await response.json());
      expect(value.ok).toBe(true);
      if (!value.ok) throw new Error('Expected entrypoint snapshot');
      expect(value.data.find((row) => row.kind === 'diagnostic-fixture')?.meta).toEqual({
        count: '9n',
        self: '[circular]',
      });
    } finally {
      await app.close();
    }
  });
});

describe('public route snapshots', () => {
  it('copies captured route descriptions in both directions', () => {
    const holder = new StudioAppHolder();
    const rows: RouteDescription[] = [
      { method: 'GET', path: '/first', controller: 'App', handler: 'get', moduleId: 'app' },
    ];
    holder.captureRouteDescriptions(rows);
    rows[0]!.path = '/changed';
    const snapshot = holder.routeDescriptions!;
    snapshot[0]!.path = '/changed-again';
    expect(holder.routeDescriptions?.[0]?.path).toBe('/first');
    expect(Object.keys(holder)).toEqual([]);
  });

  it('does not invent a mounted GET row for an attributed HEAD handler', async () => {
    @Controller('/head')
    class Heads {
      @Head() head() {
        return 'ok';
      }
    }
    @Module({ imports: [StudioModule.forRoot({ token: 'head-token' })], controllers: [Heads] })
    class App {}
    const app = await VelaFactory.create(App, { adapters: [studioRuntimeAdapter] });
    try {
      const rows = collectRoutes(app.get(StudioAppHolder)).filter((row) => row.path === '/head');
      expect(rows).toEqual([
        {
          method: 'HEAD',
          path: '/head',
          handler: 'Heads#head',
          source: 'controller',
          moduleId: 'App#default',
        },
      ]);
    } finally {
      await app.close();
    }
  });
});

describe('registration scope snapshots', () => {
  it('reports exact owners and effective scopes without constructing providers', () => {
    const container = new Container();
    const constructed = vi.fn();
    @Injectable()
    class Shared {
      constructor() {
        constructed();
      }
    }
    container.register(Shared, 'singleton-owner');
    container.register(
      defineProvider(Shared, { useClass: Shared, scope: Scope.REQUEST }),
      'request-owner',
    );
    for (const moduleId of ['singleton-owner', 'request-owner']) {
      container.registerScope({
        moduleId,
        localProviders: new Set([Shared]),
        importedModules: new Set(),
        exportedTokens: new Set(),
        global: false,
        lazy: true,
      });
    }
    container.register(
      defineProvider(DiscoveryService, { useValue: new DiscoveryService(container) }),
    );
    const rows = collectModules(container);
    expect(rows.find((row) => row.moduleId === 'singleton-owner')?.providerScopes).toEqual([
      { token: 'Shared', scope: 'default' },
    ]);
    expect(rows.find((row) => row.moduleId === 'request-owner')?.providerScopes).toEqual([
      { token: 'Shared', scope: 'request' },
    ]);
    expect(constructed).not.toHaveBeenCalled();
  });
});
