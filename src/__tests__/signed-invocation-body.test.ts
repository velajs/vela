import { describe, it, expect } from 'vitest';
import {
  VelaFactory,
  Module,
  Global,
  Controller,
  Post,
  Body,
  UseGuards,
  SignedInvocation,
  SignedInvocationGuard,
  InternalDispatcher,
  URL_SIGNING_SECRET,
  INVOCATION_AUDIENCE,
  signInvocation,
} from '../index.js';
import type { InvocationClaim } from '../index.js';
import { sha256Base64Url } from '../crypto/hmac';

// The defect this file pins: vela's HTTP pipeline resolves handler args BEFORE
// guards (documented NestJS-parity contract), so `@Body()` consumes the request
// body before `SignedInvocationGuard` can read it to recompute `bodyHash`. The
// fix installs a route-scoped capture middleware (via `@SignedInvocation()`) that
// hashes the raw body BEFORE it is consumed and publishes it to the guard. These
// tests exercise the previously-broken body-carrying path end-to-end.

const SECRET = 'body-signing-secret';
const HEADER = 'x-vela-invocation';
const ROUTE = '/binv/run';
const BARE_ROUTE = '/binv/bare';

// Ledgers proving what the guarded handlers actually observed.
const observed: Array<Record<string, unknown> | undefined> = [];
const bareHits: string[] = [];

@Global()
@Module({
  providers: [{ provide: URL_SIGNING_SECRET, useValue: SECRET }],
  exports: [URL_SIGNING_SECRET],
})
class SecretModule {}

@Controller('/binv')
class BodyInvController {
  // The currently-broken shape: a signed invocation whose handler declares
  // `@Body()`. `run(@Body() body)` consumes the body during arg resolution.
  @Post('run', { name: 'binv.run' })
  @SignedInvocation()
  run(@Body() body: Record<string, unknown>): { ran: boolean; echo: Record<string, unknown> } {
    observed.push(body);
    return { ran: true, echo: body };
  }

  // Deliberate misuse: the bare guard WITHOUT the capture middleware, still on a
  // `@Body()` handler. Proves the guard fails CLOSED (403, never 500) when it
  // cannot recover the body hash.
  @Post('bare', { name: 'binv.bare' })
  @UseGuards(SignedInvocationGuard)
  bare(@Body() body: Record<string, unknown>): { ran: boolean } {
    bareHits.push('bare');
    return { ran: true, echo: body } as { ran: boolean };
  }
}

@Module({ imports: [SecretModule], controllers: [BodyInvController] })
class AppModule {}

type App = Awaited<ReturnType<typeof VelaFactory.create>>;

/** Sign a token for a body-carrying route; `overrides` skew a field for negatives. */
function tokenFor(path: string, overrides: Partial<InvocationClaim> = {}): Promise<string> {
  const claim: InvocationClaim = {
    aud: INVOCATION_AUDIENCE,
    method: 'POST',
    path,
    bodyHash: '',
    exp: Math.floor(Date.now() / 1000) + 60,
    nonce: crypto.randomUUID(),
    ...overrides,
  };
  return signInvocation(claim, SECRET);
}

async function send(
  app: App,
  path: string,
  token: string | undefined,
  body?: string,
): Promise<Response> {
  const headers = new Headers();
  if (token !== undefined) headers.set(HEADER, token);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return app.getHonoApp().request(path, {
    method: 'POST',
    headers,
    ...(body !== undefined ? { body } : {}),
  });
}

describe('SignedInvocation guard — @Body()-carrying signed routes', () => {
  it('round-trips a signed invocation with a JSON body → 200, handler sees the exact body', async () => {
    observed.length = 0;
    const app = await VelaFactory.create(AppModule);

    const result = await app
      .get(InternalDispatcher)
      .run<{ ran: boolean; echo: Record<string, unknown> }>(
        { route: 'binv.run' },
        { body: { tenant: 'acme', n: 7 } },
      );

    expect(result).toEqual({ ran: true, echo: { tenant: 'acme', n: 7 } });
    // The handler ran in-isolate and received the parsed body verbatim.
    expect(observed).toEqual([{ tenant: 'acme', n: 7 }]);
    await app.dispose();
  });

  it('rejects a tampered body with 403 — one body byte flipped AFTER signing', async () => {
    observed.length = 0;
    const app = await VelaFactory.create(AppModule);

    const bodyText = JSON.stringify({ tenant: 'acme', n: 7 });
    const bodyHash = await sha256Base64Url(new TextEncoder().encode(bodyText));
    const token = await tokenFor(ROUTE, { bodyHash });

    // Flip a single byte of the delivered body: 7 → 8. The signed bodyHash no
    // longer matches the live body, so the guard rejects it.
    const tamperedText = bodyText.replace('"n":7', '"n":8');
    expect(tamperedText).not.toBe(bodyText);

    const res = await send(app, ROUTE, token, tamperedText);
    expect(res.status).toBe(403);
    // The handler never ran.
    expect(observed).toEqual([]);
    await app.dispose();
  });

  it('accepts the untampered body signed the same way → 200 (control for the tamper case)', async () => {
    observed.length = 0;
    const app = await VelaFactory.create(AppModule);

    const bodyText = JSON.stringify({ tenant: 'acme', n: 7 });
    const bodyHash = await sha256Base64Url(new TextEncoder().encode(bodyText));
    const token = await tokenFor(ROUTE, { bodyHash });

    const res = await send(app, ROUTE, token, bodyText);
    expect(res.status).toBe(200);
    expect(observed).toEqual([{ tenant: 'acme', n: 7 }]);
    await app.dispose();
  });

  it('rejects a claim that says empty when the request carries a body → 403', async () => {
    observed.length = 0;
    const app = await VelaFactory.create(AppModule);
    const token = await tokenFor(ROUTE, { bodyHash: '' });
    const res = await send(app, ROUTE, token, JSON.stringify({ swapped: true }));
    expect(res.status).toBe(403);
    expect(observed).toEqual([]);
    await app.dispose();
  });

  it('rejects a signature-tampered token on a body route → 403 (first sig char flipped)', async () => {
    observed.length = 0;
    const app = await VelaFactory.create(AppModule);

    const bodyText = JSON.stringify({ tenant: 'acme', n: 7 });
    const bodyHash = await sha256Base64Url(new TextEncoder().encode(bodyText));
    const token = await tokenFor(ROUTE, { bodyHash });

    // Flip the FIRST character of the signature segment — always significant.
    const dot = token.indexOf('.');
    const sigHead = token.charAt(dot + 1);
    const tampered = token.slice(0, dot + 1) + (sigHead === 'A' ? 'B' : 'A') + token.slice(dot + 2);

    const res = await send(app, ROUTE, tampered, bodyText);
    expect(res.status).toBe(403);
    expect(observed).toEqual([]);
    await app.dispose();
  });

  it('a bodyless run against a @Body() handler → 200 (empty hash, body undefined)', async () => {
    observed.length = 0;
    const app = await VelaFactory.create(AppModule);

    const result = await app
      .get(InternalDispatcher)
      .run<{ ran: boolean; echo: Record<string, unknown> }>({ route: 'binv.run' });

    expect(result.ran).toBe(true);
    // No body was sent, so `@Body()` resolves to undefined; the empty bodyHash
    // matched and the guard admitted the request.
    expect(observed).toEqual([undefined]);
    await app.dispose();
  });

  it('the BARE guard (no capture middleware) on a @Body() handler fails CLOSED with 403, not 500', async () => {
    bareHits.length = 0;
    const app = await VelaFactory.create(AppModule);

    // A perfectly valid token for the bare route with a matching body hash. The
    // capture middleware is ABSENT (bare `@UseGuards`), so args-before-guards
    // consumes the body before the guard runs; the guard cannot re-read it and
    // must reject rather than throw a 500.
    const bodyText = JSON.stringify({ tenant: 'acme', n: 7 });
    const bodyHash = await sha256Base64Url(new TextEncoder().encode(bodyText));
    const token = await tokenFor(BARE_ROUTE, { bodyHash });

    const res = await send(app, BARE_ROUTE, token, bodyText);
    expect(res.status).toBe(403);
    expect(bareHits).toEqual([]);
    await app.dispose();
  });

  it('never leaks the signing secret in a 403 body from a body route', async () => {
    const app = await VelaFactory.create(AppModule);
    const res = await send(app, ROUTE, 'not-a-valid-token', JSON.stringify({ x: 1 }));
    const text = await res.text();
    expect(res.status).toBe(403);
    expect(text).not.toContain(SECRET);
    await app.dispose();
  });
});
