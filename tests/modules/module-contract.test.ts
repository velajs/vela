import { readdirSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Module, type DynamicModule } from '@velajs/vela';
import { ModuleLoader, RouteManager } from '@velajs/vela/internal';
import { Container } from '@velajs/vela/module-kit';

/** Public module census: registration names follow ownership rather than one uniform method. */

const PACKAGES = join(__dirname, '..', '..', 'packages');

interface Manifest {
  name: string;
  bin?: string | Record<string, string>;
  exports?: Record<string, { import?: string }>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** Not configurable modules: the compiled test module of `@velajs/testing`. */
const NOT_CONFIGURABLE = new Set(['@velajs/testing#TestingModule']);

/** Structural options a module's graph needs at the call site. */
const STRUCTURAL: Record<string, Record<string, unknown>> = {
  RpcClientModule: { name: 'conformance' },
};

interface ExportedModule {
  id: string;
  name: string;
  module: Record<string, unknown> & (new () => object);
}

/**
 * Workers-only entries Node cannot evaluate (`cloudflare:workers`,
 * `cloudflare:test`, bundled WASM). None exports a module; any other
 * unloadable entry fails the census.
 */
const WORKERS_ONLY = new Set([
  '@velajs/cloudflare/durable-objects',
  '@velajs/cloudflare/entrypoints',
  '@velajs/cloudflare/testing',
  '@velajs/cloudflare/tracing',
  '@velajs/cloudflare/workflows',
  '@velajs/cloudflare/workflow-definitions',
  '@velajs/authz-cedar/cloudflare',
]);

/** Entries that failed to load outside {@link WORKERS_ONLY}. */
const unloadable: string[] = [];

async function exportedModules(): Promise<ExportedModule[]> {
  const found = new Map<unknown, ExportedModule>();
  for (const dir of readdirSync(PACKAGES)) {
    let manifest: Manifest;
    try {
      manifest = JSON.parse(readFileSync(join(PACKAGES, dir, 'package.json'), 'utf8')) as Manifest;
    } catch {
      continue;
    }
    const dependsOnVela =
      manifest.name === '@velajs/vela' ||
      '@velajs/vela' in (manifest.dependencies ?? {}) ||
      '@velajs/vela' in (manifest.peerDependencies ?? {});
    if (!dependsOnVela) continue;
    // A bin target runs its program when imported (the CLI parses the test
    // worker's argv), and a program exports no module.
    const bins = new Set(
      Object.values(
        typeof manifest.bin === 'string' ? { [manifest.name]: manifest.bin } : (manifest.bin ?? {}),
      ).map((target) => normalize(target)),
    );
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      if (!target.import?.endsWith('.js')) continue;
      if (bins.has(normalize(target.import))) continue;
      if (WORKERS_ONLY.has(`${manifest.name}${subpath.slice(1)}`)) continue;
      let entry: Record<string, unknown>;
      try {
        entry = await import(pathToFileURL(join(PACKAGES, dir, target.import)).href);
      } catch (error) {
        unloadable.push(`${manifest.name}${subpath.slice(1)}: ${String(error).slice(0, 120)}`);
        continue;
      }
      for (const [name, value] of Object.entries(entry)) {
        if (!/^[A-Z]\w*Module$/.test(name) || typeof value !== 'function') continue;
        const id = `${manifest.name}#${name}`;
        if (NOT_CONFIGURABLE.has(id) || found.has(value)) continue;
        found.set(value, { id, name, module: value as ExportedModule['module'] });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const modules = await exportedModules();

type Contract = 'shared' | 'local' | 'named' | 'bare' | 'feature';
const CONTRACTS: Record<string, Contract> = {
  ConfigModule: 'shared',
  ErrorsModule: 'shared',
  CacheModule: 'shared',
  LoggingModule: 'shared',
  SecurityModule: 'shared',
  ThrottlerModule: 'shared',
  I18nModule: 'shared',
  ScheduleModule: 'shared',
  QueueModule: 'shared',
  WebSocketModule: 'shared',
  LiveModule: 'shared',
  OpenApiModule: 'shared',
  BetterAuthModule: 'shared',
  AuthzModule: 'shared',
  CedarModule: 'shared',
  CloudflareAccessModule: 'shared',
  TenantModule: 'shared',
  FeatureFlagsModule: 'shared',
  CrudModule: 'shared',
  GraphqlModule: 'shared',
  RpcModule: 'shared',
  StudioModule: 'shared',
  HttpModule: 'local',
  MailModule: 'local',
  CryptoModule: 'local',
  StorageModule: 'named',
  RpcClientModule: 'named',
  EventEmitterModule: 'bare',
  HealthModule: 'bare',
  ScheduleNodeModule: 'bare',
  SeederModule: 'feature',
};
const FEATURE_MODULES = new Set([
  'ConfigModule',
  'CrudModule',
  'QueueModule',
  'I18nModule',
  'SeederModule',
]);
const configured = modules.filter(({ name }) =>
  ['shared', 'local', 'named'].includes(CONTRACTS[name] ?? ''),
);

function statics({ name, module }: ExportedModule) {
  const method = CONTRACTS[name] === 'shared' ? 'forRoot' : 'register';
  const sync = module[method];
  const async = module[`${method}Async`];
  if (typeof sync !== 'function' || typeof async !== 'function') {
    throw new Error(`${name} is missing ${method}/${method}Async`);
  }
  return {
    sync: (options: Record<string, unknown>): DynamicModule =>
      Reflect.apply(sync, module, [options]) as DynamicModule,
    async: (options: Record<string, unknown>): DynamicModule =>
      Reflect.apply(async, module, [options]) as DynamicModule,
  };
}

/** Load without instantiating providers: test registration identity separately from valid runtime options. */
function load(imports: DynamicModule[]): void {
  class Root {}
  Module({ imports })(Root);
  const container = new Container({ diagnostics: 'throw' });
  new ModuleLoader(container, new RouteManager(container)).load(Root);
}

describe('public module contracts', () => {
  it('classifies every exported module and finds every declared contract', () => {
    expect(unloadable).toEqual([]);
    expect(modules.map(({ name }) => name).sort()).toEqual(Object.keys(CONTRACTS).sort());
  });

  it.each(modules)('$id exposes only its selected registration API', (entry) => {
    const { name, module } = entry;
    const contract = CONTRACTS[name];
    if (contract === 'bare' || contract === 'feature') {
      for (const method of ['forRoot', 'forRootAsync', 'register', 'registerAsync']) {
        expect(module[method]).toBeUndefined();
      }
    } else {
      statics(entry);
      const removed = contract === 'shared' ? 'register' : 'forRoot';
      expect(module[removed]).toBeUndefined();
      expect(module[`${removed}Async`]).toBeUndefined();
    }
    if (FEATURE_MODULES.has(name)) expect(typeof module.forFeature).toBe('function');
    expect(module.registerQueue).toBeUndefined();
    expect(module.registerMessages).toBeUndefined();
  });

  it.each(configured)('$id uses its declared instance ownership', (entry) => {
    const { name } = entry;
    const { async } = statics(entry);
    const structural = STRUCTURAL[name] ?? {};
    const first = async({ ...structural, useFactory: () => ({}) });
    const second = async({ ...structural, useFactory: () => ({}), lazy: true });
    if (CONTRACTS[name] === 'local' || name === 'QueueModule') {
      expect(second.key).not.toBe(first.key);
    } else {
      expect(second.key).toBe(first.key);
    }
    const named = async({ ...structural, useFactory: () => ({}), key: 'conformance' });
    expect(named.key).toContain('conformance');
  });

  it.each(configured)(
    '$id shares reused definitions and handles independent registrations',
    (entry) => {
      const { name } = entry;
      const { async } = statics(entry);
      const structural = STRUCTURAL[name] ?? {};
      const definition = async({ ...structural, useFactory: () => ({}) });
      expect(() => load([definition, definition])).not.toThrow();
      const other = async({ ...structural, useFactory: () => ({}) });
      if (CONTRACTS[name] === 'local') {
        expect(() => load([definition, other])).not.toThrow();
      } else if (name === 'QueueModule') {
        // The queue bootstrap separately rejects multiple application drivers.
        expect(other.key).not.toBe(definition.key);
      } else {
        expect(() => load([definition, other])).toThrow(
          /was imported again with different options/,
        );
      }
    },
  );

  it.each(configured)(
    '$id keeps provider visibility separate from explicit instance identity',
    (entry) => {
      if (entry.name === 'QueueModule') return;
      const { async } = statics(entry);
      const structural = STRUCTURAL[entry.name] ?? {};
      const useFactory = () => ({});
      const plain = async({ ...structural, useFactory, key: 'visibility' });
      const global = async({ ...structural, useFactory, key: 'visibility', isGlobal: true });
      expect(global.key).toBe(plain.key);
    },
  );
});
