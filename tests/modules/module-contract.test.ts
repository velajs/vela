import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Module, type DynamicModule } from '@velajs/vela';
import { ModuleLoader, RouteManager } from '@velajs/vela/internal';
import { Container } from '@velajs/vela/module-kit';

/**
 * The uniform module contract, checked across every published package: each
 * exported `*Module` class is authored on `defineModule`, exposes `forRoot`
 * and `forRootAsync`, keys instances by its structural options (never by the
 * factory it was given), strips registration controls from the key, and has
 * the module loader report a second configuration under the same key.
 */

const PACKAGES = join(__dirname, '..', '..', 'packages');

interface Manifest {
  name: string;
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
 * Workers-only entries Node cannot evaluate (`cloudflare:workers`, bundled
 * WASM). Neither exports a module; any other unloadable entry fails the census.
 */
const WORKERS_ONLY = new Set([
  '@velajs/cloudflare/durable-objects',
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
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      if (!target.import?.endsWith('.js')) continue;
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

function statics(module: ExportedModule['module']) {
  const forRoot = module.forRoot;
  const forRootAsync = module.forRootAsync;
  if (typeof forRoot !== 'function' || typeof forRootAsync !== 'function') {
    throw new Error('missing forRoot/forRootAsync');
  }
  return {
    forRoot: (options: Record<string, unknown>): DynamicModule =>
      Reflect.apply(forRoot, module, [options]) as DynamicModule,
    forRootAsync: (options: Record<string, unknown>): DynamicModule =>
      Reflect.apply(forRootAsync, module, [options]) as DynamicModule,
  };
}

/** Load a root importing `imports` without instantiating any provider. */
function load(imports: DynamicModule[]): void {
  class Root {}
  Module({ imports })(Root);
  const container = new Container({ diagnostics: 'throw' });
  new ModuleLoader(container, new RouteManager(container)).load(Root);
}

describe('uniform module contract', () => {
  it('finds the first-party modules', () => {
    expect(unloadable).toEqual([]);
    const names = modules.map(({ id }) => id);
    expect(names.length).toBeGreaterThan(25);
    expect(names).toEqual(
      expect.arrayContaining([
        '@velajs/vela#CacheModule',
        '@velajs/vela#EventEmitterModule',
        '@velajs/vela#ScheduleModule',
        '@velajs/storage#StorageModule',
        '@velajs/mail#MailModule',
        '@velajs/better-auth#BetterAuthModule',
        '@velajs/graphql#GraphqlModule',
        '@velajs/rpc#RpcClientModule',
      ]),
    );
  });

  it.each(modules)('$id exposes forRoot and forRootAsync', ({ module }) => {
    expect(typeof module.forRoot).toBe('function');
    expect(typeof module.forRootAsync).toBe('function');
  });

  it.each(modules)('$id: forRootAsync keys by structural options only', ({ name, module }) => {
    const { forRootAsync } = statics(module);
    const structural = STRUCTURAL[name] ?? {};
    const first = forRootAsync({ ...structural, useFactory: () => ({}) });
    const second = forRootAsync({ ...structural, useFactory: () => ({}), lazy: true });
    expect(first.module).toBe(module);
    expect(typeof first.key).toBe('string');
    // A different factory and registration controls never change the key...
    if (name !== 'QueueModule') expect(second.key).toBe(first.key);
    // ...and the caller's explicit key names the instance.
    const named = forRootAsync({ ...structural, useFactory: () => ({}), key: 'conformance' });
    expect(named.key).toContain('conformance');
  });

  it.each(modules)(
    '$id: a second configuration is reported, the same one deduplicated',
    ({ name, module }) => {
      const { forRootAsync } = statics(module);
      const structural = STRUCTURAL[name] ?? {};
      const definition = forRootAsync({ ...structural, useFactory: () => ({}) });
      expect(() => load([definition, definition])).not.toThrow();
      const other = forRootAsync({ ...structural, useFactory: () => ({}) });
      if (name === 'QueueModule') {
        // A queue configuration keys by reference: a second one is its own
        // instance, which queue bootstrap rejects (see queue-registration).
        expect(other.key).not.toBe(definition.key);
        return;
      }
      expect(() => load([definition, other])).toThrow(/was imported again with different options/);
    },
  );

  it.each(modules)('$id: the isGlobal extra does not change the key', ({ name, module }) => {
    const { forRootAsync } = statics(module);
    const structural = STRUCTURAL[name] ?? {};
    const useFactory = () => ({});
    const plain = forRootAsync({ ...structural, useFactory });
    const global = forRootAsync({ ...structural, useFactory, isGlobal: true });
    if (name !== 'QueueModule') expect(global.key).toBe(plain.key);
  });
});
