import { spawn } from 'node:child_process';

const PORT = 8789;
const BASE = `http://localhost:${PORT}`;

function log(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitForReady(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let jar = '';
function captureCookies(res: Response): void {
  const sc = res.headers.get('set-cookie');
  if (!sc) return;
  const pairs = sc
    .split(/,\s*(?=[a-zA-Z0-9_-]+=)/)
    .map((c) => c.split(';')[0]!.trim());
  jar = pairs.join('; ');
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { origin: 'http://localhost' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (jar) headers.cookie = jar;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, init);
  captureCookies(res);
  return res;
}

console.log('auth-lab-d1 wrangler smoke (D1-backed)');
console.log('--------------------------------------');
console.log(`Spawning wrangler dev --local --port ${PORT}...`);

const child = spawn('pnpm', ['exec', 'wrangler', 'dev', '--local', `--port`, String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});

const wranglerLog: string[] = [];
child.stdout.on('data', (b) => wranglerLog.push(b.toString()));
child.stderr.on('data', (b) => wranglerLog.push(b.toString()));

const ready = await waitForReady(60_000);
if (!ready) {
  console.error('wrangler dev did not become ready within 60s');
  console.error(wranglerLog.join(''));
  child.kill();
  process.exit(1);
}

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed++;
  else failed++;
  log(name, ok, detail);
}

try {
  // 1. Public health route — proves D1Module loaded cleanly even without sign-up.
  {
    const res = await call('GET', '/healthz');
    check('GET /healthz → 200', res.status === 200);
  }

  // 2. /me without session → 401.
  {
    const res = await call('GET', '/me');
    check('GET /me without session → 401', res.status === 401);
  }

  // 3. Sign up — persists to D1, returns session cookie.
  {
    const res = await call('POST', '/api/auth/sign-up/email', {
      email: 'd1-smoke@example.com',
      password: 'SuperSecret123!',
      name: 'D1 Smoke',
    });
    check('sign-up → 200', res.status === 200, `status ${res.status}`);
    check('cookie captured', jar.length > 0);
  }

  // 4. /me with cookie — proves the session row was written to D1 and is
  //    reloadable via drizzleAdapter.
  {
    const res = await call('GET', '/me');
    check('/me with cookie → 200', res.status === 200);
    if (res.status === 200) {
      const body = (await res.json()) as { email: string };
      check(
        '/me returns the signed-up user from D1',
        body.email === 'd1-smoke@example.com',
        JSON.stringify(body),
      );
    }
  }
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 200));
}

console.log('--------------------------------------');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('--- wrangler log ---');
  console.error(wranglerLog.join(''));
  process.exit(1);
}
