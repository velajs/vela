import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV } from '@velajs/vela';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, resolveConfig } from '../config.js';
import { withApp } from '../with-app.js';
import { classifyWorkerExports } from './worker-entry.js';

// Fixtures live under this package so the workspace packages they import resolve.
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let project: string;

const WORKER = (prefix: string) => `
import { Controller, Get, Module } from '@velajs/vela';
import { createCloudflareWorker } from '@velajs/cloudflare';
import { DurableObject, WorkerEntrypoint, WorkflowEntrypoint } from 'cloudflare:workers';

class HelloController { hello() { return { ok: true }; } }
Get()(HelloController.prototype, 'hello', Object.getOwnPropertyDescriptor(HelloController.prototype, 'hello'));
Controller('/hello')(HelloController);
export class AppModule {}
Module({ controllers: [HelloController] })(AppModule);

export class Counter extends DurableObject {}
export class SignupFlow extends WorkflowEntrypoint {}
export class Admin extends WorkerEntrypoint {}
export const notAClass = 1;
export default createCloudflareWorker(AppModule, { globalPrefix: ${JSON.stringify(prefix)} });
`;

function write(file: string, content: string): void {
  mkdirSync(dirname(join(project, file)), { recursive: true });
  writeFileSync(join(project, file), content);
}

beforeAll(() => {
  project = mkdtempSync(join(packageDir, '.test-worker-'));
  write(
    'wrangler.jsonc',
    `{
      // A comment, as wrangler.jsonc allows.
      "name": "fixture",
      "main": "src/worker.mjs",
      "compatibility_date": "2026-09-20",
      "vars": { "GREETING": "top" },
      "env": {
        "staging": { "main": "src/staging.mjs", "vars": { "GREETING": "staging" } },
        "plain": { "main": "src/plain.mjs" },
      },
    }`,
  );
  write('src/worker.mjs', WORKER('/api'));
  write('src/staging.mjs', WORKER('/staging'));
  write('src/plain.mjs', 'export default { fetch() { return new Response("hi"); } };\n');
  // A stand-in for the project's Wrangler, whose getPlatformProxy() supplies local bindings.
  write(
    'node_modules/wrangler/package.json',
    '{ "name": "wrangler", "type": "module", "main": "index.js" }',
  );
  write(
    'node_modules/wrangler/index.js',
    `export async function getPlatformProxy(options) {
      globalThis.platformOptions = options;
      return { env: { DB: 'local database' }, async dispose() { globalThis.platformDisposed = true; } };
    }`,
  );
});
afterAll(() => rmSync(project, { recursive: true, force: true }));

describe('loading the Worker entry without a vela.config', () => {
  it('resolves the Wrangler file after the config candidates', async () => {
    const resolution = await resolveConfig(project);
    expect(resolution).toMatchObject({ path: join(project, 'wrangler.jsonc'), source: 'wrangler' });
    expect(resolution.candidates.slice(-2)).toEqual([
      join(project, 'wrangler.json'),
      join(project, 'wrangler.jsonc'),
    ]);
  });

  it('builds the application createCloudflareWorker() describes with the Wrangler vars', async () => {
    const loaded = await loadConfig(project);
    expect(loaded.source).toBe('wrangler');
    expect(loaded.config.rootModule?.name).toBe('AppModule');
    const described = await withApp(
      loaded,
      (app) => ({
        env: app.get(ENV),
        routes: app.describeRoutes().map((route) => `${route.method} ${route.path}`),
      }),
      () => {},
    );
    expect(described).toEqual({ env: { GREETING: 'top' }, routes: ['GET /api/hello'] });
  });

  it('selects the main and vars of a named environment', async () => {
    const loaded = await loadConfig(project, undefined, { environment: 'staging' });
    const described = await withApp(
      loaded,
      (app) => ({ env: app.get(ENV), prefix: app.getGlobalPrefix() }),
      () => {},
    );
    expect(described).toEqual({ env: { GREETING: 'staging' }, prefix: '/staging' });
  });

  it("uses Wrangler's local platform for local bindings and closes it with the config", async () => {
    const loaded = await loadConfig(project, undefined, { bindings: 'local' });
    const env = await withApp(
      loaded,
      (app) => app.get(ENV),
      () => {},
    );
    expect(env).toEqual({ DB: 'local database' });
    expect(Reflect.get(globalThis, 'platformOptions')).toEqual({
      configPath: join(project, 'wrangler.jsonc'),
    });
    expect(Reflect.get(globalThis, 'platformDisposed')).toBe(true);
  });

  it('classifies the Durable Object, Workflow and entrypoint classes the Worker exports', async () => {
    const loaded = await loadConfig(project);
    try {
      const entry = await loaded.importModule(join(project, 'src/worker.mjs'));
      expect(await classifyWorkerExports(entry, loaded.importModule)).toEqual({
        durableObjects: ['Counter'],
        workflows: ['SignupFlow'],
        entrypoints: ['Admin'],
      });
    } finally {
      await loaded.dispose();
    }
  });

  it('explains a Worker entry that is not createCloudflareWorker()', async () => {
    await expect(loadConfig(project, undefined, { environment: 'plain' })).rejects.toThrow(
      /does not default-export createCloudflareWorker\(AppModule\)/,
    );
    await expect(loadConfig(project, undefined, { environment: 'missing' })).rejects.toThrow(
      /"missing" is not declared/,
    );
  });
});
