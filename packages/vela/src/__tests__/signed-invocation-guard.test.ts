import { defineProvider } from '../container/types';
import { describe, it, expect } from 'vitest';
import {
  VelaFactory,
  Module,
  Global,
  Controller,
  Injectable,
  Post,
  SignedInvocation,
  InternalDispatcher,
  MultipleProvidersFoundError,
  NONCE_STORE,
  URL_SIGNING_SECRET,
  INVOCATION_AUDIENCE,
  signInvocation,
} from '../index.js';
import type { InvocationClaim, NonceStore } from '../index.js';

const SECRET = 'guard-signing-secret';
const HEADER = 'x-vela-invocation';
const ROUTE = '/inv/run';

// A module-scoped ledger proving the guarded handler actually ran in-isolate.
const hits: string[] = [];

@Global()
@Module({
  providers: [defineProvider(URL_SIGNING_SECRET, { useValue: SECRET })],
  exports: [URL_SIGNING_SECRET],
})
class SecretModule {}

@Controller('/inv')
class InvController {
  @Post('run', { name: 'inv.run' })
  @SignedInvocation()
  run() {
    hits.push('run');
    return { ran: true };
  }
}

@Module({ imports: [SecretModule], controllers: [InvController] })
class AppModule {}

type App = Awaited<ReturnType<typeof VelaFactory.create>>;

/** Sign a token for the guarded route; overrides let negative tests skew a field. */
function tokenFor(overrides: Partial<InvocationClaim> = {}): Promise<string> {
  const claim: InvocationClaim = {
    aud: INVOCATION_AUDIENCE,
    method: 'POST',
    path: ROUTE,
    bodyHash: '',
    exp: Math.floor(Date.now() / 1000) + 60,
    nonce: crypto.randomUUID(),
    ...overrides,
  };
  return signInvocation(claim, SECRET);
}

async function send(app: App, token: string | undefined, body?: string): Promise<Response> {
  const headers = new Headers();
  if (token !== undefined) headers.set(HEADER, token);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return app.getHonoApp().request(ROUTE, {
    method: 'POST',
    headers,
    ...(body !== undefined ? { body } : {}),
  });
}

describe('SignedInvocation guard — @SignedInvocation() route', () => {
  it('returns 200 for a freshly signed invocation via InternalDispatcher.run', async () => {
    hits.length = 0;
    const app = await VelaFactory.create(AppModule);
    const result = await app.get(InternalDispatcher).run<{ ran: boolean }>({ route: 'inv.run' });

    expect(result).toEqual({ ran: true });
    expect(hits).toEqual(['run']); // executed in-isolate, same process
    await app.dispose();
  });

  it('validates a matching body hash end-to-end (run with a body → 200)', async () => {
    const app = await VelaFactory.create(AppModule);
    const result = await app
      .get(InternalDispatcher)
      .run<{ ran: boolean }>({ route: 'inv.run' }, { body: { tenant: 'acme', n: 7 } });

    expect(result).toEqual({ ran: true });
    await app.dispose();
  });

  it('rejects a missing token with 403', async () => {
    const app = await VelaFactory.create(AppModule);
    const res = await send(app, undefined);
    expect(res.status).toBe(403);
    await app.dispose();
  });

  it('rejects a tampered token with 403', async () => {
    const app = await VelaFactory.create(AppModule);
    const token = await tokenFor();
    // Flip the FIRST character of the signature segment. The final base64url
    // char of a 32-byte HMAC is zero-pad-aligned (only its top bits are
    // significant), so mutating it can decode to identical bytes; the first
    // char is fully significant, so this always changes the decoded signature.
    const dot = token.indexOf('.');
    const sigHead = token.charAt(dot + 1);
    const tampered = token.slice(0, dot + 1) + (sigHead === 'A' ? 'B' : 'A') + token.slice(dot + 2);
    expect((await send(app, tampered)).status).toBe(403);
    await app.dispose();
  });

  it('rejects an expired token with 403', async () => {
    const app = await VelaFactory.create(AppModule);
    const token = await tokenFor({ exp: Math.floor(Date.now() / 1000) - 5 });
    expect((await send(app, token)).status).toBe(403);
    await app.dispose();
  });

  it('rejects a method mismatch with 403', async () => {
    const app = await VelaFactory.create(AppModule);
    const token = await tokenFor({ method: 'PUT' }); // signed for PUT, sent as POST
    expect((await send(app, token)).status).toBe(403);
    await app.dispose();
  });

  it('rejects a path mismatch with 403', async () => {
    const app = await VelaFactory.create(AppModule);
    const token = await tokenFor({ path: '/inv/elsewhere' });
    expect((await send(app, token)).status).toBe(403);
    await app.dispose();
  });

  it('rejects a body-hash mismatch with 403 (claim says empty, request has a body)', async () => {
    const app = await VelaFactory.create(AppModule);
    const token = await tokenFor({ bodyHash: '' });
    expect((await send(app, token, JSON.stringify({ swapped: true }))).status).toBe(403);
    await app.dispose();
  });

  it('rejects a replayed nonce with 403 on the second delivery (single-use)', async () => {
    hits.length = 0;
    const app = await VelaFactory.create(AppModule);
    const token = await tokenFor();

    expect((await send(app, token)).status).toBe(200);
    expect((await send(app, token)).status).toBe(403); // same nonce → replay rejected
    expect(hits).toEqual(['run']); // handler ran exactly once
    await app.dispose();
  });

  it('never leaks the signing secret in the 403 body', async () => {
    const app = await VelaFactory.create(AppModule);
    const res = await send(app, 'not-a-valid-token');
    const text = await res.text();
    expect(res.status).toBe(403);
    expect(text).not.toContain(SECRET);
    await app.dispose();
  });
});

describe('SignedInvocation guard — a @Global() NONCE_STORE', () => {
  // A store every application shares, as a Durable Object or KV-backed one is.
  const claimed = new Set<string>();

  @Injectable()
  class DurableNonceStore implements NonceStore {
    async claim(nonce: string): Promise<boolean> {
      if (claimed.has(nonce)) return false;
      claimed.add(nonce);
      return true;
    }
  }

  @Global()
  @Module({
    providers: [{ provide: NONCE_STORE, useClass: DurableNonceStore }],
    exports: [NONCE_STORE],
  })
  class NonceModule {}

  @Module({ imports: [NonceModule, AppModule] })
  class DurableAppModule {}

  it('protects every application sharing it against a replayed nonce', async () => {
    hits.length = 0;
    const first = await VelaFactory.create(DurableAppModule);
    const second = await VelaFactory.create(DurableAppModule);
    const token = await tokenFor();

    expect(first.get(NONCE_STORE)).toBeInstanceOf(DurableNonceStore);
    expect((await send(first, token)).status).toBe(200);
    // The guard claims the nonce in the module's store, not in a per-application default.
    expect((await send(second, token)).status).toBe(403);
    expect(hits).toEqual(['run']);
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it('reports a NONCE_STORE that two @Global() modules export', async () => {
    @Global()
    @Module({
      providers: [{ provide: NONCE_STORE, useClass: DurableNonceStore }],
      exports: [NONCE_STORE],
    })
    class OtherNonceModule {}

    @Module({ imports: [NonceModule, OtherNonceModule, AppModule] })
    class AmbiguousAppModule {}

    hits.length = 0;
    const app = await VelaFactory.create(AmbiguousAppModule);
    expect(() => app.get(NONCE_STORE)).toThrow(MultipleProvidersFoundError);
    expect((await send(app, await tokenFor())).status).toBe(500);
    expect(hits).toEqual([]);
    await app.dispose();
  });
});
