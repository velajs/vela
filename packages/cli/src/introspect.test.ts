import { describe, expect, it } from 'vitest';
import {
  Controller,
  Get,
  Head,
  Injectable,
  InjectionToken,
  defineProvider,
  Module,
  VelaFactory,
} from '@velajs/vela';
import type { VelaApplication } from '@velajs/vela';
import { Process, Processor, QueueModule } from '@velajs/vela/queue';
import {
  collectEntrypoints,
  collectModules,
  collectRoutes,
  renderModuleTree,
} from './introspect.js';
import { renderTable } from './format.js';

const SHARED = new InjectionToken<string>('cli-test:shared');

async function fixtureApp(): Promise<VelaApplication> {
  @Controller({ path: 'users', version: 1 })
  class UsersController {
    @Get(':id')
    getOne() {
      return {};
    }

    @Head('ping')
    ping() {
      return {};
    }
  }

  @Injectable()
  class LazyThing {}

  @Processor('email')
  @Injectable()
  class EmailProcessor {
    @Process('welcome')
    welcome() {}
  }

  @Module({ lazy: true, providers: [LazyThing] })
  class LazyMod {}

  @Module({ providers: [defineProvider(SHARED, { useValue: 'x' })], exports: [SHARED] })
  class SharedMod {}

  @Module({
    imports: [SharedMod, LazyMod, QueueModule.forRoot({ queues: ['email'] })],
    controllers: [UsersController],
    providers: [EmailProcessor],
  })
  class App {}

  return VelaFactory.create(App, { globalPrefix: '/api' });
}

describe('collectRoutes', () => {
  it('lists composed controller routes and labels extras as mounted', async () => {
    const app = await fixtureApp();
    const rows = collectRoutes(app)!;

    expect(rows).toContainEqual({
      method: 'GET',
      path: '/api/v1/users/:id',
      handler: 'UsersController#getOne',
      source: 'controller',
    });
    expect(rows).toContainEqual({
      method: 'HEAD',
      path: '/api/v1/users/ping',
      handler: 'UsersController#ping',
      source: 'controller',
    });
    // @Head's GET registration must not resurface as a mounted duplicate.
    expect(rows.filter((r) => r.path === '/api/v1/users/ping')).toHaveLength(1);
    // Middleware mounts ('ALL') never appear.
    expect(rows.every((r) => r.method !== 'ALL')).toBe(true);
    await app.dispose();
  });
});

describe('collectModules / renderModuleTree', () => {
  it('describes the graph with lazy flags and renders a rooted tree', async () => {
    const app = await fixtureApp();
    const modules = collectModules(app);
    const lazyMod = modules.find((m) => m.moduleId === 'LazyMod#default')!;
    expect(lazyMod.lazy).toBe(true);

    const lines = renderModuleTree(modules);
    const appLine = lines.find((l) => l.startsWith('App#default'))!;
    expect(appLine).toBeDefined();
    expect(lines.some((l) => l.includes('LazyMod#default (lazy)'))).toBe(true);
    expect(lines.some((l) => l.trimStart().startsWith('SharedMod#default'))).toBe(true);
    await app.dispose();
  });
});

describe('collectEntrypoints', () => {
  it('lists declared kinds with entries (metadata-only lazy entries fine)', async () => {
    const app = await fixtureApp();
    const rows = collectEntrypoints(app);
    const queueRows = rows.filter((r) => r.kind === 'queue');
    expect(queueRows).toHaveLength(1);
    expect(queueRows[0].target).toBe('EmailProcessor');
    expect(queueRows[0].meta).toContain('"queueName":"email"');
    await app.dispose();
  });
});

describe('renderTable', () => {
  it('aligns columns', () => {
    const lines = renderTable(
      ['A', 'LONG'],
      [
        ['x', 'y'],
        ['xxx', 'yy'],
      ],
    );
    expect(lines[0]).toBe('A    LONG');
    expect(lines[2]).toBe('x    y');
    expect(lines[3]).toBe('xxx  yy');
  });
});
