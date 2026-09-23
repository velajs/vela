import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { type VelaEnv } from '@velajs/vela';
import { countRegisteredClasses } from '@velajs/vela/internal';
import { CRUD_DATABASES } from '@velajs/crud';
import { createCloudflareApp, type createCloudflareWorker } from '@velajs/cloudflare';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app';
import worker from '../src/worker';

/** A Worker or an application built for one environment. */
type Target = Pick<ReturnType<typeof createCloudflareWorker>, 'fetch'>;

/** Reads the body before waiting: the request finishes once its body is consumed. */
async function call(target: Target, path: string, init: RequestInit = {}, bindings: VelaEnv = env) {
  const ctx = createExecutionContext();
  const response = await target.fetch(new Request(`http://localhost${path}`, init), bindings, ctx);
  const body: unknown = await response.json();
  await waitOnExecutionContext(ctx);
  return { status: response.status, body };
}

function create(target: Target, path: string, item: { id: string; title: string }) {
  return call(target, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(item),
  });
}

describe('multi-database Worker under workerd', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.PRIMARY_DB, env.PRIMARY_MIGRATIONS);
    await applyD1Migrations(env.ANALYTICS_DB, env.ANALYTICS_MIGRATIONS);
  });

  it('stores the same id independently in each named database', async () => {
    expect((await create(worker, '/primary/items', { id: 'same', title: 'Primary' })).status).toBe(
      201,
    );
    expect(
      (await create(worker, '/analytics/items', { id: 'same', title: 'Analytics' })).status,
    ).toBe(201);

    expect((await call(worker, '/primary/items/same')).body).toMatchObject({
      result: { id: 'same', title: 'Primary' },
    });
    expect((await call(worker, '/analytics/items/same')).body).toMatchObject({
      result: { id: 'same', title: 'Analytics' },
    });
    const primary = await env.PRIMARY_DB.prepare('SELECT title FROM items WHERE id = ?')
      .bind('same')
      .first();
    expect(primary).toEqual({ title: 'Primary' });
  });

  it('builds one database registry per environment from the static root', async () => {
    const classes = countRegisteredClasses();
    const first: VelaEnv = { ...env };
    const second: VelaEnv = { ...env };
    const firstApp = await createCloudflareApp(AppModule, { env: first });
    const secondApp = await createCloudflareApp(AppModule, { env: second });

    expect(countRegisteredClasses()).toBe(classes);
    const firstDatabases = firstApp.get(CRUD_DATABASES);
    const secondDatabases = secondApp.get(CRUD_DATABASES);
    expect(firstDatabases).toBeDefined();
    expect(firstDatabases).not.toBe(secondDatabases);
    expect(firstDatabases?.resolve('primary').handle).not.toBe(
      secondDatabases?.resolve('primary').handle,
    );
    expect(firstDatabases?.defaultDatabase).toBe('primary');
  });
});
