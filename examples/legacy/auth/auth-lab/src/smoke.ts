import { createApp } from './app.js';

const app = await createApp();
const hono = app.getHonoApp();

// Cookie jar — capture Set-Cookie from responses and replay as Cookie header.
let jar = '';

function captureCookies(res: Response): void {
  const sc = res.headers.get('set-cookie');
  if (!sc) return;
  // Naive: Hono concatenates multiple Set-Cookie with comma. Pull just the
  // name=value pair from each, drop attributes (Path, HttpOnly, etc.).
  const pairs = sc.split(/,\s*(?=[a-zA-Z0-9_-]+=)/).map((c) => c.split(';')[0]!.trim());
  jar = pairs.join('; ');
}

async function go(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    // better-auth checks Origin against trustedOrigins for state-changing methods.
    origin: 'http://localhost',
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (jar) headers.cookie = jar;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await hono.request(path, init);
  captureCookies(res);
  return res;
}

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

console.log('auth-lab smoke');
console.log('--------------');

// 1. Public route — no auth needed.
{
  const res = await go('GET', '/stats');
  const body = (await res.json()) as { users: number };
  check('public route returns 200 (no auth)', res.status === 200);
  check('public route shows 0 users initially', body.users === 0, `got ${body.users}`);
}

// 2. Protected route without session → 401.
{
  const res = await go('GET', '/me');
  check('GET /me without session → 401', res.status === 401, `got ${res.status}`);
}

// 3. Sign up via better-auth's mounted handler.
{
  const res = await go('POST', '/api/auth/sign-up/email', {
    email: 'ada@example.com',
    password: 'SuperSecret123!',
    name: 'Ada Lovelace',
  });
  check(
    'POST /api/auth/sign-up/email → 200',
    res.status === 200,
    `got ${res.status}: ${await res.clone().text()}`,
  );
  check('sign-up sets a session cookie', jar.length > 0, `jar="${jar}"`);
}

// 4. Protected route with session cookie → user info.
{
  const res = await go('GET', '/me');
  check('GET /me with session → 200', res.status === 200, `got ${res.status}`);
  if (res.status === 200) {
    const body = (await res.json()) as { id: string; email: string; name: string };
    check('GET /me returns the signed-up user', body.email === 'ada@example.com', JSON.stringify(body));
    check('GET /me returns user id', typeof body.id === 'string' && body.id.length > 0);
  }
}

// 5. Session details endpoint.
{
  const res = await go('GET', '/me/session');
  check('GET /me/session → 200', res.status === 200, `got ${res.status}`);
  if (res.status === 200) {
    const body = (await res.json()) as { sessionId: string; userId: string };
    check('session has id + userId', typeof body.sessionId === 'string' && typeof body.userId === 'string');
  }
}

// 6. Stats now reflects the new user (StatsService injected with BETTER_AUTH).
{
  const res = await go('GET', '/stats');
  const body = (await res.json()) as { users: number };
  check('stats reflects 1 user after sign-up', body.users === 1, `got ${body.users}`);
}

// 7. Sign out → cookie invalidated.
{
  const res = await go('POST', '/api/auth/sign-out');
  check('POST /api/auth/sign-out → 200', res.status === 200, `got ${res.status}`);
}

// 8. After sign-out, /me → 401 again.
{
  const res = await go('GET', '/me');
  check('GET /me after sign-out → 401', res.status === 401, `got ${res.status}`);
}

console.log('--------------');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
