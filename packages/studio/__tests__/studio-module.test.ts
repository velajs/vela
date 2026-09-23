import { defineProvider } from '@velajs/vela';
import { describe, expect, it } from 'vitest';
import { Injectable, Module, VelaFactory } from '@velajs/vela';
import type { ProviderDefinition, Type } from '@velajs/vela';
import {
  AdminRpc,
  ConfirmTokenSigner,
  AdminSubTokenSigner,
  StudioModule,
  STUDIO_TEST_ONLY_OPS,
} from '../src';
import type { AdminOpContext, StudioModuleOptions } from '../src';
import { STUDIO_PROTOCOL_VERSION } from '@velajs/studio-protocol';
import type { AdminErrorBody } from '@velajs/studio-protocol';

const TOKEN = 'test-master-token-value';
const BASE = '/_vela/admin';

async function makeApp(
  options: StudioModuleOptions,
  extra: Array<Type | ProviderDefinition> = [],
): Promise<Awaited<ReturnType<typeof VelaFactory.create>>> {
  @Module({ imports: [StudioModule.forRoot(options)], providers: extra })
  class AppModule {}
  return VelaFactory.create(AppModule);
}

function authed(body: unknown, ip = '10.0.0.1'): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      'x-forwarded-for': ip,
    },
    body: JSON.stringify(body),
  };
}

describe('StudioModule — default-closed (no token)', () => {
  it('health reports enabled:false and does not existence-hide', async () => {
    const app = await makeApp({});
    const res = await app.getHonoApp().request(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, protocolVersion: STUDIO_PROTOCOL_VERSION });
  });

  it('rpc route 404s STUDIO_DISABLED when no token configured', async () => {
    const app = await makeApp({});
    const res = await app.getHonoApp().request(`${BASE}/rpc/app.routes`, authed({}));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('STUDIO_DISABLED');
  });

  it('ws-token route 404s STUDIO_DISABLED when disabled', async () => {
    const app = await makeApp({});
    const res = await app.getHonoApp().request(`${BASE}/ws-token`, authed({}));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('STUDIO_DISABLED');
  });
});

describe('StudioModule — auth', () => {
  it('health is enabled:true when a token is configured', async () => {
    const app = await makeApp({ token: TOKEN });
    const res = await app.getHonoApp().request(`${BASE}/health`);
    expect(await res.json()).toEqual({ enabled: true, protocolVersion: STUDIO_PROTOCOL_VERSION });
  });

  it('missing bearer -> 401 STUDIO_UNAUTHORIZED', async () => {
    const app = await makeApp({ token: TOKEN });
    const res = await app.getHonoApp().request(`${BASE}/rpc/app.routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('STUDIO_UNAUTHORIZED');
  });

  it('wrong bearer -> 401 STUDIO_UNAUTHORIZED', async () => {
    const app = await makeApp({ token: TOKEN });
    const res = await app.getHonoApp().request(`${BASE}/rpc/app.routes`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('STUDIO_UNAUTHORIZED');
  });
});

describe('StudioModule — dispatch', () => {
  it('unknown op -> 404 STUDIO_UNKNOWN_OP', async () => {
    const app = await makeApp({ token: TOKEN });
    const res = await app.getHonoApp().request(`${BASE}/rpc/queue.list`, authed({}));
    // 'queue.list' is a real op but has no registered handler in this app (M5
    // registers app.*/logs/audit/studio/data ops, not the queue panel).
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('STUDIO_UNKNOWN_OP');
  });

  it('@AdminRpc happy path returns { ok, data, meta } (real op + stub handler)', async () => {
    @Injectable()
    class QueueOps {
      @AdminRpc({ op: 'queue.list' })
      list() {
        return [{ name: 'jobs' }];
      }
    }
    const app = await makeApp({ token: TOKEN }, [QueueOps]);
    const res = await app.getHonoApp().request(`${BASE}/rpc/queue.list`, authed({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      op: string;
      data: unknown;
      meta: { op: string; mode: string; ms: number };
    };
    expect(body.ok).toBe(true);
    expect(body.op).toBe('queue.list');
    expect(body.data).toEqual([{ name: 'jobs' }]);
    expect(body.meta.mode).toBe('read');
    expect(typeof body.meta.ms).toBe('number');
  });

  it('test-only escape: fake op is allowed via STUDIO_TEST_ONLY_OPS', async () => {
    @Injectable()
    class FakeOps {
      @AdminRpc({ op: 'test.echo' })
      echo(_ctx: AdminOpContext, args: unknown) {
        return { echoed: args };
      }
    }
    const app = await makeApp({ token: TOKEN }, [
      FakeOps,
      defineProvider(STUDIO_TEST_ONLY_OPS, { useValue: ['test.echo'] }),
    ]);
    const res = await app
      .getHonoApp()
      .request(`${BASE}/rpc/test.echo`, authed({ args: { hi: 1 } }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ echoed: { hi: 1 } });
  });

  it('duplicate op registration throws at bootstrap', async () => {
    @Injectable()
    class A {
      @AdminRpc({ op: 'queue.list' })
      list() {
        return [];
      }
    }
    @Injectable()
    class B {
      @AdminRpc({ op: 'queue.list' })
      listToo() {
        return [];
      }
    }
    await expect(makeApp({ token: TOKEN }, [A, B])).rejects.toThrow(
      /duplicate handler for op 'queue.list'/,
    );
  });

  it('unknown op-name registration throws at bootstrap', async () => {
    @Injectable()
    class Bad {
      @AdminRpc({ op: 'totally.not.an.op' })
      handler() {
        return null;
      }
    }
    await expect(makeApp({ token: TOKEN }, [Bad])).rejects.toThrow(/is not a\s+known Studio op/);
  });

  it('internal error message is redacted (never echoed)', async () => {
    @Injectable()
    class Boom {
      @AdminRpc({ op: 'queue.list' })
      list() {
        throw new Error('SUPER SECRET internal db dsn leak');
      }
    }
    const app = await makeApp({ token: TOKEN }, [Boom]);
    const res = await app.getHonoApp().request(`${BASE}/rpc/queue.list`, authed({}));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).not.toContain('SUPER SECRET');
    expect(body.error.message).toBe('Internal Server Error');
    expect(body.error.code).toBe('internal');
  });
});

describe('StudioModule — write gating & confirm', () => {
  it('write op with its gate closed -> 403 STUDIO_OP_FORBIDDEN', async () => {
    // api.authorizeTryIt is a real StudioModule handler (mode:write gate:opsEditable);
    // ops is disabled by default, so the gate closes before the handler runs.
    const app = await makeApp({ token: TOKEN });
    const res = await app
      .getHonoApp()
      .request(`${BASE}/rpc/api.authorizeTryIt`, authed({ args: {} }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('STUDIO_OP_FORBIDDEN');
  });

  it('data write op with data gate closed -> 403 DATA_EDIT_DISABLED', async () => {
    @Injectable()
    class DataOps {
      @AdminRpc({ op: 'data.writeRow' })
      writeRow() {
        return {};
      }
    }
    const app = await makeApp({ token: TOKEN }, [DataOps]);
    const res = await app.getHonoApp().request(`${BASE}/rpc/data.writeRow`, authed({ args: {} }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('DATA_EDIT_DISABLED');
  });

  it('destructive op without confirmToken -> 428 STUDIO_CONFIRM_REQUIRED', async () => {
    @Injectable()
    class DeleteOps {
      @AdminRpc({ op: 'data.deleteRows' })
      deleteRows() {
        return { deleted: 1 };
      }
    }
    const app = await makeApp({ token: TOKEN, editable: { data: true } }, [DeleteOps]);
    const res = await app
      .getHonoApp()
      .request(`${BASE}/rpc/data.deleteRows`, authed({ args: { model: 'User', ids: ['1'] } }));
    expect(res.status).toBe(428);
    expect((await res.json()).error.code).toBe('STUDIO_CONFIRM_REQUIRED');
  });

  it('destructive op with a valid confirmToken succeeds', async () => {
    @Injectable()
    class DeleteOps {
      @AdminRpc({ op: 'data.deleteRows' })
      deleteRows() {
        return { deleted: 2 };
      }
    }
    const app = await makeApp({ token: TOKEN, editable: { data: true } }, [DeleteOps]);
    const signer = app.getContainer().resolve(ConfirmTokenSigner);
    const payload = { model: 'User', ids: ['1', '2'] };
    const { token } = await signer.issue('data.deleteRows', payload);
    const res = await app
      .getHonoApp()
      .request(
        `${BASE}/rpc/data.deleteRows`,
        authed({ args: { ...payload, confirmToken: token } }),
      );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ deleted: 2 });
  });
});

describe('StudioModule — ws-token + rate limit', () => {
  it('mints a sub-token that the signer verifies', async () => {
    const app = await makeApp({ token: TOKEN });
    const res = await app.getHonoApp().request(`${BASE}/ws-token`, authed({ room: 'room-9' }));
    expect(res.status).toBe(200);
    const { token, exp } = (await res.json()) as { token: string; exp: number };
    expect(typeof token).toBe('string');
    const claims = await app.getContainer().resolve(AdminSubTokenSigner).verify(token);
    expect(claims).not.toBeNull();
    expect(claims?.scope).toBe('live');
    expect(claims?.room).toBe('room-9');
    expect(claims?.exp).toBe(exp);
  });

  it('returns 429 STUDIO_RATE_LIMITED after max requests from one IP', async () => {
    @Injectable()
    class QueueOps {
      @AdminRpc({ op: 'queue.list' })
      list() {
        return [];
      }
    }
    const app = await makeApp({ token: TOKEN, rateLimit: { windowMs: 60_000, max: 2 } }, [
      QueueOps,
    ]);
    const hono = app.getHonoApp();
    const ip = '203.0.113.7';
    expect((await hono.request(`${BASE}/rpc/queue.list`, authed({}, ip))).status).toBe(200);
    expect((await hono.request(`${BASE}/rpc/queue.list`, authed({}, ip))).status).toBe(200);
    const third = await hono.request(`${BASE}/rpc/queue.list`, authed({}, ip));
    expect(third.status).toBe(429);
    expect((await third.json()).error.code).toBe('STUDIO_RATE_LIMITED');
  });

  it('pre-auth throttle 429s an unauthenticated flood BEFORE the bearer check', async () => {
    // Pre-auth ceiling = 5× post-auth max = 10. Requests with no bearer would
    // each 401; once the fixed-window counter is exhausted the throttle fires
    // first, proving it runs ahead of authentication.
    const app = await makeApp({ token: TOKEN, rateLimit: { windowMs: 60_000, max: 2 } });
    const hono = app.getHonoApp();
    const ip = '198.51.100.9';
    const noAuth = (): RequestInit => ({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: '{}',
    });
    for (let i = 0; i < 10; i++) {
      expect((await hono.request(`${BASE}/rpc/app.routes`, noAuth())).status).toBe(401);
    }
    const flooded = await hono.request(`${BASE}/rpc/app.routes`, noAuth());
    expect(flooded.status).toBe(429);
    expect((await flooded.json()).error.code).toBe('STUDIO_RATE_LIMITED');
  });
});

describe('StudioModule — JSON request bodies', () => {
  function plain(body: string, contentType?: string): RequestInit {
    return {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'x-forwarded-for': '10.0.0.7',
        ...(contentType === undefined ? {} : { 'content-type': contentType }),
      },
      body: new TextEncoder().encode(body),
    };
  }

  @Injectable()
  class QueueOps {
    @AdminRpc({ op: 'queue.list' })
    list() {
      return [{ name: 'jobs' }];
    }
  }

  for (const [path, op] of [
    ['/rpc/queue.list', 'queue.list'],
    ['/ws-token', 'studio.wsToken'],
  ] as const) {
    it(`${op} refuses a non-JSON body with the 415 envelope`, async () => {
      const app = await makeApp({ token: TOKEN }, [QueueOps]);
      for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', undefined]) {
        const res = await app.getHonoApp().request(`${BASE}${path}`, plain('{}', contentType));
        expect(res.status, String(contentType)).toBe(415);
        const body = (await res.json()) as {
          ok: boolean;
          op: string;
          error: AdminErrorBody;
          status: number;
        };
        expect(body.ok).toBe(false);
        expect(body.op).toBe(op);
        expect(body.status).toBe(415);
        expect(body.error.code).toBe('unsupported_media_type');
        expect(body.error.status).toBe(415);
      }
    });
  }

  it('dispatches a request without a body', async () => {
    const app = await makeApp({ token: TOKEN }, [QueueOps]);
    const res = await app.getHonoApp().request(`${BASE}/rpc/queue.list`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-forwarded-for': '10.0.0.8' },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([{ name: 'jobs' }]);
  });
});

describe('StudioModule — ws-token pre-dispatch error envelope', () => {
  it('carries the declared error branch shape with a stable pseudo-op', async () => {
    // /ws-token is not an @AdminRpc op, but its pre-dispatch errors must still be
    // the protocol error branch: { ok:false, op, error, status } — never an
    // undeclared shape missing `op`.
    const app = await makeApp({ token: TOKEN });
    const res = await app.getHonoApp().request(`${BASE}/ws-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      ok: boolean;
      op: string;
      error: AdminErrorBody;
      status: number;
    };
    expect(body.ok).toBe(false);
    expect(body.op).toBe('studio.wsToken');
    expect(body.status).toBe(401);
    expect(body.error.code).toBe('STUDIO_UNAUTHORIZED');
    expect(typeof body.error.title).toBe('string');
    expect(typeof body.error.message).toBe('string');
    expect(body.error.status).toBe(401);
  });

  it('includes the pseudo-op when Studio is disabled too', async () => {
    const app = await makeApp({});
    const res = await app.getHonoApp().request(`${BASE}/ws-token`, authed({}));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; op: string; error: { code: string } };
    expect(body.op).toBe('studio.wsToken');
    expect(body.error.code).toBe('STUDIO_DISABLED');
  });
});

describe('StudioModule — forRootAsync', () => {
  it('mounts + health via forRootAsync({ useFactory })', async () => {
    @Module({
      imports: [
        StudioModule.forRootAsync({
          useFactory: (): StudioModuleOptions => ({ token: TOKEN }),
        }),
      ],
    })
    class AsyncAppModule {}
    const app = await VelaFactory.create(AsyncAppModule);
    const res = await app.getHonoApp().request(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, protocolVersion: STUDIO_PROTOCOL_VERSION });
  });

  it('plumbs async-resolved options end-to-end (editable gate open on dispatch)', async () => {
    @Injectable()
    class DataOps {
      @AdminRpc({ op: 'data.writeRow' })
      writeRow() {
        return { written: true };
      }
    }
    @Module({
      imports: [
        StudioModule.forRootAsync({
          useFactory: async (): Promise<StudioModuleOptions> => {
            await Promise.resolve();
            return { token: TOKEN, editable: { data: true } };
          },
        }),
      ],
      providers: [DataOps],
    })
    class AsyncAppModule {}
    const app = await VelaFactory.create(AsyncAppModule);
    // With data editing enabled via the async factory, the write op is NOT gated.
    const res = await app.getHonoApp().request(`${BASE}/rpc/data.writeRow`, authed({ args: {} }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ written: true });
  });
});
