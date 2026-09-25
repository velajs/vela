import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { ENV } from '@velajs/vela';
import { createOpenApiDocument } from '@velajs/vela/openapi';
import { Cli } from 'clipanion';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EntrypointListCommand, OpenApiDumpCommand } from '../commands/introspect.commands.js';
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

// A DynamicModule root, and an entry that spreads the Worker to add a handler.
const DYNAMIC_WORKER = `
import { Controller, Get, Module } from '@velajs/vela';
import { createCloudflareWorker } from '@velajs/cloudflare';

class ExtraController { extra() { return { extra: true }; } }
Get()(ExtraController.prototype, 'extra', Object.getOwnPropertyDescriptor(ExtraController.prototype, 'extra'));
Controller('/extra')(ExtraController);
class ExtraModule {}
Module({ controllers: [ExtraController] })(ExtraModule);
export class AppModule {}
Module({})(AppModule);

const worker = createCloudflareWorker({ module: AppModule, imports: [ExtraModule] });
export default { ...worker, async email() {} };
`;

// One app definition: its Worker and the Durable Object classes defined from it.
const APP_WORKER = `
import { Injectable, Module } from '@velajs/vela';
import { WebSocketModule } from '@velajs/vela/websocket';
import { defineCloudflareApp } from '@velajs/cloudflare';
import { VelaDurableObject, VelaWebSocketDurableObject } from '@velajs/cloudflare/durable-objects';
import { VelaEntrypoint } from '@velajs/cloudflare/entrypoints';
import { VelaWorkflow } from '@velajs/cloudflare/workflows';

export class AppModule {}
Module({ imports: [WebSocketModule.forRoot()] })(AppModule);
class CounterHost { increment(by) { return by; } alarm() {} }
Injectable()(CounterHost);
class AuditHost { record() {} }
Injectable()(AuditHost);
class SignupHost { async run() {} }
Injectable()(SignupHost);
class ReportHost { async run() {} }
Injectable()(ReportHost);
class BillingHost { charge() {} refund() {} }
Injectable()(BillingHost);

const app = defineCloudflareApp(AppModule);
export class Counter extends VelaDurableObject(app, CounterHost, { rpc: ['increment'] }) {}
export class Lobby extends VelaWebSocketDurableObject(app) {}
export class Signup extends VelaWorkflow(app, SignupHost) {}
export class Billing extends VelaEntrypoint(app, BillingHost, { rpc: ['charge'] }) {}
// Defined from the app, but no export serves them.
VelaDurableObject(app, AuditHost, { rpc: ['record'] });
VelaWorkflow(app, ReportHost);
export default app.worker;
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
        "dynamic": { "main": "src/dynamic.mjs" },
        "app": { "main": "src/app.mjs" },
      },
    }`,
  );
  write('src/worker.mjs', WORKER('/api'));
  write('src/staging.mjs', WORKER('/staging'));
  write('src/plain.mjs', 'export default { fetch() { return new Response("hi"); } };\n');
  write('src/dynamic.mjs', DYNAMIC_WORKER);
  write('src/app.mjs', APP_WORKER);
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
afterEach(() => vi.restoreAllMocks());

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
    const root = loaded.config.rootModule;
    expect(typeof root === 'function' ? root.name : root).toBe('AppModule');
    const described = await withApp(
      async () => loaded,
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
      async () => loaded,
      (app) => ({ env: app.get(ENV), prefix: app.getGlobalPrefix() }),
      () => {},
    );
    expect(described).toEqual({ env: { GREETING: 'staging' }, prefix: '/staging' });
  });

  it("uses Wrangler's local platform for local bindings and closes it with the config", async () => {
    const loaded = await loadConfig(project, undefined, { bindings: 'local' });
    const env = await withApp(
      async () => loaded,
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
        velaDurableObjects: [],
        velaWorkflows: [],
        velaEntrypoints: [],
        unexported: [],
      });
    } finally {
      await loaded.dispose();
    }
  });

  it('describes the Durable Object classes defined from a defineCloudflareApp() app', async () => {
    const loaded = await loadConfig(project, undefined, { environment: 'app' });
    try {
      const root = loaded.config.rootModule;
      expect(typeof root === 'function' ? root.name : root).toBe('AppModule');
      expect(loaded.main).toBe(join(project, 'src/app.mjs'));
      const entry = await loaded.importModule(join(project, 'src/app.mjs'));
      expect(await classifyWorkerExports(entry, loaded.importModule)).toEqual({
        durableObjects: ['Counter', 'Lobby'],
        workflows: ['Signup'],
        entrypoints: ['Billing'],
        velaDurableObjects: [
          { name: 'Counter', kind: 'host', host: 'CounterHost', methods: ['increment'] },
          {
            name: 'Lobby',
            kind: 'websocket',
            methods: [
              'broadcast',
              'invalidate',
              'inspectLive',
              'pitrCurrentBookmark',
              'pitrBookmarkForTime',
              'pitrArmRestore',
            ],
          },
        ],
        velaWorkflows: [{ name: 'Signup', host: 'SignupHost' }],
        velaEntrypoints: [{ name: 'Billing', host: 'BillingHost', methods: ['charge'] }],
        unexported: [
          { kind: 'durable-object', serves: 'AuditHost', methods: ['record'] },
          { kind: 'workflow', serves: 'ReportHost', methods: [] },
        ],
      });
    } finally {
      await loaded.dispose();
    }
  });

  it('lists the Durable Object, Workflow and service entrypoint classes of the Worker entry', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    const stdout = new PassThrough();
    let output = '';
    stdout.on('data', (chunk: Buffer) => (output += String(chunk)));
    const code = await Cli.from([EntrypointListCommand], { binaryName: 'vela' }).run(
      ['entrypoint', 'list', '--json', '--env', 'app'],
      { stdout, stderr: new PassThrough() },
    );
    expect(code, output).toBe(0);
    const rows: Array<{ kind: string; target: string; meta: string }> = JSON.parse(output);
    expect(rows.filter((row) => row.kind === 'cf:durable-object')).toEqual([
      {
        kind: 'cf:durable-object',
        target: 'Counter',
        meta: JSON.stringify({ kind: 'host', host: 'CounterHost', methods: ['increment'] }),
      },
      {
        kind: 'cf:durable-object',
        target: 'Lobby',
        meta: JSON.stringify({
          kind: 'websocket',
          methods: [
            'broadcast',
            'invalidate',
            'inspectLive',
            'pitrCurrentBookmark',
            'pitrBookmarkForTime',
            'pitrArmRestore',
          ],
        }),
      },
      {
        kind: 'cf:durable-object',
        target: '(not exported) AuditHost',
        meta: JSON.stringify({
          exported: false,
          kind: 'host',
          host: 'AuditHost',
          methods: ['record'],
        }),
      },
    ]);
    expect(
      rows.filter((row) => row.kind === 'cf:workflow' || row.kind === 'cf:entrypoint'),
    ).toEqual([
      { kind: 'cf:workflow', target: 'Signup', meta: JSON.stringify({ host: 'SignupHost' }) },
      {
        kind: 'cf:workflow',
        target: '(not exported) ReportHost',
        meta: JSON.stringify({ exported: false, host: 'ReportHost' }),
      },
      {
        kind: 'cf:entrypoint',
        target: 'Billing',
        meta: JSON.stringify({ host: 'BillingHost', methods: ['charge'] }),
      },
    ]);
  });

  it('loads the Worker entry of an explicitly named Wrangler file', async () => {
    write(
      'wrangler.preview.jsonc',
      '{ "name": "preview", "main": "src/staging.mjs", "vars": { "GREETING": "preview" } }',
    );
    const loaded = await loadConfig(project, undefined, { wrangler: 'wrangler.preview.jsonc' });
    expect(loaded.path).toBe(join(project, 'wrangler.preview.jsonc'));
    const described = await withApp(
      async () => loaded,
      (app) => ({ env: app.get(ENV), prefix: app.getGlobalPrefix() }),
      () => {},
    );
    expect(described).toEqual({ env: { GREETING: 'preview' }, prefix: '/staging' });
  });

  it('keeps a DynamicModule root whole, through an entry that spreads the Worker', async () => {
    const loaded = await loadConfig(project, undefined, { environment: 'dynamic' });
    const root = loaded.config.rootModule;
    expect(typeof root === 'object' ? root.module.name : root).toBe('AppModule');
    const described = await withApp(
      async () => loaded,
      (app) => ({
        routes: app.describeRoutes().map((route) => `${route.method} ${route.path}`),
        paths: root === undefined ? [] : Object.keys(createOpenApiDocument(root).paths),
      }),
      () => {},
    );
    expect(described).toEqual({ routes: ['GET /extra'], paths: ['/extra'] });
  });

  it('dumps the OpenAPI document of a named environment', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    const stdout = new PassThrough();
    let output = '';
    stdout.on('data', (chunk: Buffer) => (output += String(chunk)));
    const code = await Cli.from([OpenApiDumpCommand], { binaryName: 'vela' }).run(
      ['openapi', 'dump', '--env', 'dynamic'],
      { stdout, stderr: new PassThrough() },
    );
    expect(code, output).toBe(0);
    expect(Object.keys(JSON.parse(output).paths)).toEqual(['/extra']);
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
