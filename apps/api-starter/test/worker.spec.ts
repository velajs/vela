import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { Controller, Get, Injectable, Module, type VelaEnv } from '@velajs/vela';
import { countRegisteredClasses } from '@velajs/vela/internal';
import { BetterAuthService } from '@velajs/better-auth';
import { CRUD_DEFAULT_ADAPTER } from '@velajs/crud';
import { createCloudflareApp, createCloudflareWorker } from '@velajs/cloudflare';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app';
import worker from '../src/worker';

const origin = 'http://localhost:8790';

/** A Worker or an application built for one environment. */
type Target = Pick<ReturnType<typeof createCloudflareWorker>, 'fetch'>;

/** Reads the body before waiting: the request finishes once its body is consumed. */
async function call(target: Target, path: string, init: RequestInit = {}, bindings: VelaEnv = env) {
  const ctx = createExecutionContext();
  const url = new URL(path, bindings.APP_ORIGIN);
  const response = await target.fetch(new Request(url, init), bindings, ctx);
  const text = response.status === 101 ? '' : await response.text();
  await waitOnExecutionContext(ctx);
  return { response, text };
}

/** Signs up a fresh account through `target` and returns its email and session cookie. */
async function signUp(target: Target, bindings: VelaEnv = env) {
  const email = `oxc-${crypto.randomUUID()}@example.com`;
  const signup = await call(
    target,
    '/api/auth/sign-up/email',
    {
      method: 'POST',
      headers: { origin: bindings.APP_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Worker spec', email, password: crypto.randomUUID() }),
    },
    bindings,
  );
  expect(signup.response.status).toBe(200);
  const cookie = signup.response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  return { email, cookie };
}

/** Opens `/rooms/:room/ws` and closes an accepted socket straight away. */
async function upgrade(
  target: Target,
  room: string,
  headers: Record<string, string>,
  bindings: VelaEnv = env,
): Promise<number> {
  const { response } = await call(
    target,
    `/rooms/${room}/ws`,
    { headers: { ...headers, upgrade: 'websocket' } },
    bindings,
  );
  response.webSocket?.accept();
  response.webSocket?.close(1000, 'done');
  return response.status;
}

describe('api-starter compiled by Oxc under workerd', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });

  it('serves public routes and rejects anonymous CRUD', async () => {
    const health = await call(worker, '/healthz');
    expect(health.response.status).toBe(200);
    expect(JSON.parse(health.text)).toEqual({ ok: true });
    expect((await call(worker, '/todos')).response.status).toBe(401);
  });

  it("serves the application's OpenAPI document without documenting itself", async () => {
    const { response, text } = await call(worker, '/openapi.json');
    expect(response.status).toBe(200);
    const document: unknown = JSON.parse(text);
    expect(document).toMatchObject({
      openapi: '3.1.0',
      info: { title: 'Vela API starter', version: '1.0.0' },
      paths: { '/todos': {}, '/me': {}, '/healthz': {} },
    });
    expect(document).not.toHaveProperty(['paths', '/openapi.json']);
  });

  it('signs up, reads the session and upgrades into the LiveRoom Durable Object', async () => {
    const { email, cookie } = await signUp(worker);
    const me = await call(worker, '/me', { headers: { origin, cookie } });
    expect(JSON.parse(me.text)).toMatchObject({ email });

    // BetterAuthUpgradeAuthenticator verifies the same session cookie, and the
    // app's tenant resolver admits only the shared board's room.
    expect(await upgrade(worker, 'default', { origin, cookie })).toBe(101);
    expect(await upgrade(worker, 'other', { origin, cookie })).toBe(403);
    expect(await upgrade(worker, 'default', { origin })).toBe(403);
    expect(await upgrade(worker, 'default', { origin: 'https://elsewhere.example', cookie })).toBe(
      403,
    );
  });

  it('builds one application per environment from the static root', async () => {
    const first: VelaEnv = { ...env, APP_ORIGIN: 'http://first.localhost:8790' };
    const second: VelaEnv = { ...env, APP_ORIGIN: 'http://second.localhost:8790' };
    const classes = countRegisteredClasses();
    const firstApp = await createCloudflareApp(AppModule, { env: first });
    const secondApp = await createCloudflareApp(AppModule, { env: second });

    // The root is declared once, so a second environment declares no classes.
    expect(countRegisteredClasses()).toBe(classes);
    // Each environment's factories build their own CRUD adapter and auth instance.
    expect(firstApp.get(CRUD_DEFAULT_ADAPTER)).not.toBe(secondApp.get(CRUD_DEFAULT_ADAPTER));
    expect(firstApp.get(BetterAuthService).auth).not.toBe(secondApp.get(BetterAuthService).auth);

    // Both environments share the D1 database, so the session is valid in each
    // application, while every application admits only its own APP_ORIGIN.
    const { cookie } = await signUp(firstApp, first);
    expect(await upgrade(firstApp, 'default', { origin: first.APP_ORIGIN, cookie }, first)).toBe(
      101,
    );
    expect(await upgrade(secondApp, 'default', { origin: first.APP_ORIGIN, cookie }, second)).toBe(
      403,
    );
    expect(await upgrade(secondApp, 'default', { origin: second.APP_ORIGIN, cookie }, second)).toBe(
      101,
    );
  });

  it('injects a class dependency from the design:paramtypes Oxc emits', async () => {
    @Injectable()
    class Greeter {
      greet(name: string) {
        return `hello ${name}`;
      }
    }
    @Controller('/greet')
    class GreetController {
      // No @Inject: the constructor type is the only token.
      constructor(private readonly greeter: Greeter) {}
      @Get()
      greet() {
        return { message: this.greeter.greet('oxc') };
      }
    }
    @Module({ controllers: [GreetController], providers: [Greeter] })
    class GreetModule {}

    const greet = await call(createCloudflareWorker(GreetModule), '/greet');
    expect(JSON.parse(greet.text)).toEqual({ message: 'hello oxc' });
  });
});
