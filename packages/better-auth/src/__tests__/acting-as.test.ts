import { Controller, Get, UseGuards } from '@velajs/vela';
import { getTrustedRequestIdentity, setTrustedRequestIdentity } from '@velajs/vela/module-kit';
import { Test } from '@velajs/testing';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { describe, expect, it } from 'vitest';
import { AuthGuard, BetterAuthModule, BetterAuthService, CurrentUser } from '../index';
import { actingAs } from '../testing';

/** A real betterAuth instance backed by an in-memory adapter. */
function makeRealAuth() {
  // Seed the model arrays: unlike a migrated SQL store, the memory adapter
  // throws on a read against a table it has never written to.
  const db: Record<string, unknown[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };
  return betterAuth({
    baseURL: 'http://localhost',
    secret: 'acting-as-test-secret-please-ignore-0123456789',
    emailAndPassword: { enabled: true },
    database: memoryAdapter(db),
  });
}

@Controller('/me')
@UseGuards(AuthGuard)
class MeController {
  @Get()
  me(@CurrentUser() user: { id: string; email: string }) {
    return { id: user.id, email: user.email };
  }
}

describe('actingAs (@velajs/better-auth/testing)', () => {
  it('mints a signed session cookie a guarded route accepts', async () => {
    const auth = makeRealAuth();
    const moduleRef = await Test.createTestingModule({
      imports: [BetterAuthModule.forRoot({ auth })],
      controllers: [MeController],
    }).compile();
    const app = await moduleRef.createApplication();

    const headers = await actingAs(moduleRef, {
      email: 'ada@example.com',
      name: 'Ada Lovelace',
    });

    // (a) a Cookie header carrying the session token cookie is produced.
    expect(headers.get('cookie')).toBeTruthy();

    // (b) a guarded route accepts the request carrying those headers.
    const res = await app.getHonoApp().request('/me', { headers });
    expect(res.status).toBe(200);
    expect((await res.json()).email).toBe('ada@example.com');
  });

  it('rejects an unauthenticated request (no session headers)', async () => {
    const auth = makeRealAuth();
    const moduleRef = await Test.createTestingModule({
      imports: [BetterAuthModule.forRoot({ auth })],
      controllers: [MeController],
    }).compile();
    const app = await moduleRef.createApplication();

    const res = await app.getHonoApp().request('/me');
    expect(res.status).toBe(401);
  });

  it('produces a real session validated by auth.api.getSession', async () => {
    const auth = makeRealAuth();
    const moduleRef = await Test.createTestingModule({
      imports: [BetterAuthModule.forRoot({ auth })],
    }).compile();

    const headers = await actingAs(moduleRef, { email: 'grace@example.com' });

    const data = await auth.api.getSession({ headers });
    expect(data).not.toBeNull();
    expect(data?.user.email).toBe('grace@example.com');
    expect(data?.session.token).toBeTruthy();
  });

  it('reuses an existing user when the principal carries a matching id', async () => {
    const auth = makeRealAuth();
    const moduleRef = await Test.createTestingModule({
      imports: [BetterAuthModule.forRoot({ auth })],
    }).compile();

    const ctx = await auth.$context;
    const existing = await ctx.internalAdapter.createUser(
      {
        email: 'alan@example.com',
        name: 'Alan Turing',
      },
      { method: 'admin' },
    );

    const headers = await actingAs(moduleRef, { id: existing.id });
    const data = await auth.api.getSession({ headers });
    expect(data?.user.id).toBe(existing.id);
    expect(data?.user.email).toBe('alan@example.com');
  });

  it('throws a clear error when the principal cannot identify a user', async () => {
    const auth = makeRealAuth();
    const moduleRef = await Test.createTestingModule({
      imports: [BetterAuthModule.forRoot({ auth })],
    }).compile();

    await expect(actingAs(moduleRef, { role: 'admin' })).rejects.toThrow(/email|id/);
  });
});

describe('logout identity lifecycle', () => {
  it('the public sign-out handler clears request identity and invalidates the real session', async () => {
    const auth = makeRealAuth();
    const moduleRef = await Test.createTestingModule({
      imports: [BetterAuthModule.forRoot({ auth })],
      controllers: [MeController],
    }).compile();
    const app = await moduleRef.createApplication();
    const headers = await actingAs(moduleRef, { email: 'logout@example.com' });
    headers.set('origin', 'http://localhost');
    const request = new Request('http://localhost/api/auth/sign-out', { method: 'POST', headers });
    setTrustedRequestIdentity(request, {
      principal: { issuer: 'prior', subject: 'user', principalType: 'user' },
      roles: ['admin'],
    });
    const response = await app.getHonoApp().fetch(request);
    expect(response.status).toBe(200);
    expect(getTrustedRequestIdentity(request)).toBeUndefined();
    expect((await app.getHonoApp().request('/me', { headers })).status).toBe(401);
    await app.dispose();
  });
});
