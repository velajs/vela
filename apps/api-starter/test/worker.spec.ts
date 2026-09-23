import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { Controller, Get, Injectable, Module } from '@velajs/vela';
import { createCloudflareWorker } from '@velajs/cloudflare';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/worker';

const origin = 'http://localhost:8790';

/** Reads the body before waiting: the request finishes once its body is consumed. */
async function call(
  target: ReturnType<typeof createCloudflareWorker>,
  path: string,
  init: RequestInit = {},
) {
  const ctx = createExecutionContext();
  const response = await target.fetch(new Request(`${origin}${path}`, init), env, ctx);
  const text = response.status === 101 ? '' : await response.text();
  await waitOnExecutionContext(ctx);
  return { response, text };
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

  it('signs up, reads the session and upgrades into the LiveRoom Durable Object', async () => {
    const email = `oxc-${crypto.randomUUID()}@example.com`;
    const signup = await call(worker, '/api/auth/sign-up/email', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Worker spec', email, password: crypto.randomUUID() }),
    });
    expect(signup.response.status).toBe(200);
    const cookie = signup.response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const me = await call(worker, '/me', { headers: { origin, cookie } });
    expect(JSON.parse(me.text)).toMatchObject({ email });

    const upgrade = await call(worker, '/rooms/default/ws', {
      headers: { origin, cookie, upgrade: 'websocket' },
    });
    expect(upgrade.response.status).toBe(101);
    const socket = upgrade.response.webSocket;
    expect(socket).not.toBeNull();
    socket?.accept();
    socket?.close(1000, 'done');
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
