// Runtime smoke against `wrangler dev` — spawns the worker, waits for it to be
// ready, then drives a sign-up / cookie / protected-route sequence via real
// HTTP. Confirms that the bundled worker actually runs at the edge runtime
// (workerd), not just under Node — bundle scans miss esbuild-introduced
// runtime hazards (see the @better-auth/memory-adapter direct-import note in
// app.ts).
import { spawn } from 'node:child_process';

const PORT = 8788;
const BASE = `http://localhost:${PORT}`;

function log(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitForReady(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/stats`);
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

console.log('auth-lab wrangler smoke');
console.log('-----------------------');
console.log(`Spawning wrangler dev --local --port ${PORT}...`);

const child = spawn('pnpm', ['exec', 'wrangler', 'dev', '--local', `--port`, String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});

// Silence wrangler's stdout/stderr in the smoke output, but keep them on
// fatal errors so failures stay diagnosable.
const wranglerLog: string[] = [];
child.stdout.on('data', (b) => wranglerLog.push(b.toString()));
child.stderr.on('data', (b) => wranglerLog.push(b.toString()));

const ready = await waitForReady(45_000);
if (!ready) {
  console.error('wrangler dev did not become ready within 45s');
  console.error(wranglerLog.join(''));
  child.kill();
  process.exit(1);
}

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed++; else failed++;
  log(name, ok, detail);
}

try {
  // 1. Public route.
  {
    const res = await call('GET', '/stats');
    const body = (await res.json()) as { users: number };
    check('public /stats → 200', res.status === 200);
    check('initial user count is 0', body.users === 0, `got ${body.users}`);
  }

  // 2. Protected without session.
  {
    const res = await call('GET', '/me');
    check('protected /me without session → 401', res.status === 401);
  }

  // 3. Sign up.
  {
    const res = await call('POST', '/api/auth/sign-up/email', {
      email: 'wrangler-smoke@example.com',
      password: 'SuperSecret123!',
      name: 'Wrangler Smoke',
    });
    check('sign-up → 200', res.status === 200, `status ${res.status}`);
    check('cookie captured', jar.length > 0);
  }

  // 4. Protected with cookie.
  {
    const res = await call('GET', '/me');
    check('/me with cookie → 200', res.status === 200);
    if (res.status === 200) {
      const body = (await res.json()) as { email: string };
      check(
        '/me returns the signed-up user',
        body.email === 'wrangler-smoke@example.com',
        JSON.stringify(body),
      );
    }
  }

  // 5. Stats reflects the new user (proves StatsService is real, not stubbed).
  {
    const res = await call('GET', '/stats');
    const body = (await res.json()) as { users: number };
    check('/stats reflects 1 user after sign-up', body.users === 1, `got ${body.users}`);
  }
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 200));
}

console.log('-----------------------');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('--- wrangler log ---');
  console.error(wranglerLog.join(''));
  process.exit(1);
}
