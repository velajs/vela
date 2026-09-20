import { createApp } from './app.js';

const app = await createApp();
const hono = app.getHonoApp();

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

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { origin: 'http://localhost' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return hono.request(path, init);
}

console.log('auth-lab-plugins smoke (Pattern B + Pattern C)');
console.log('----------------------------------------------');

// 1. Public route works.
{
  const res = await call('GET', '/healthz');
  check('public route reachable', res.status === 200);
}

// 2. Magic link plugin's route exists — the plugin was composed in via
//    forRootAsync + MAGIC_LINK_PLUGIN token (Pattern B + C).
//    Without composition, this endpoint would 404.
{
  const res = await call('POST', '/api/auth/sign-in/magic-link', {
    email: 'plugins@example.com',
  });
  check(
    'magicLink plugin endpoint registered (status != 404)',
    res.status !== 404,
    `status ${res.status}`,
  );
  // The plugin processes the request; final status depends on better-auth's
  // sign-in flow (200 on success, 4xx on validation). The key signal is that
  // the route exists at all — proves composition worked.
}

// 3. sendMagicLink callback fired through DI'd EmailService.
//    The service was wired inside MagicLinkAuthModule and the plugin uses
//    it via closure. We resolve EmailService from the app container.
{
  const { EmailService } = await import('./email.service.js');
  const email = app.get(EmailService);
  const sent = email.outboxFor('plugins@example.com');
  check(
    'EmailService captured at least one magic link',
    sent.length >= 1,
    `outbox size: ${sent.length}`,
  );
  if (sent.length >= 1) {
    check(
      'magic link URL contains a token',
      sent[0]!.url.includes('token=') || sent[0]!.token.length > 0,
      `url=${sent[0]!.url}`,
    );
  }
}

console.log('----------------------------------------------');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
