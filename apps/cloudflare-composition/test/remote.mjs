/* oxlint-disable no-await-in-loop -- Intentionally sequential, bounded remote product calls and stream reads. */
// Opt-in HTTP acceptance against an ALREADY DEPLOYED synthetic instance.
// Never reads Wrangler credentials, provisions resources, uploads objects or deploys.
import assert from 'node:assert/strict';

assert.equal(
  process.env.COMPOSITION_REMOTE,
  '1',
  'Set COMPOSITION_REMOTE=1 to opt in; remote product calls may incur usage.',
);
const target = new URL(process.env.COMPOSITION_URL ?? '');
assert.equal(target.protocol, 'https:');
assert.equal(target.username + target.password + target.search + target.hash, '');
assert.equal(target.pathname, '/');
const token = process.env.COMPOSITION_TOKEN;
assert.ok(token && token.length >= 16, 'Supply the synthetic app token explicitly.');
const selected = process.argv[2];
assert.ok(
  ['browser', 'ai', 'vpc', 'images'].includes(selected),
  'Choose exactly one case: browser, ai, vpc or images.',
);

async function call(path, type, maxBytes, body) {
  const response = await fetch(new URL(path, target), {
    method: body ? 'POST' : 'GET',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    assert.fail(`${path}: expected 200, received ${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    assert.equal(response.headers.get('content-type')?.split(';')[0], type);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      assert.ok(length <= maxBytes, `${path}: output exceeds ceiling`);
      chunks.push(chunk.value);
    }
    assert.ok(length > 0, `${path}: empty output`);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

// Denied access must fail before any product work.
const denied = await fetch(new URL('/browser/pdf', target), {
  redirect: 'error',
  signal: AbortSignal.timeout(10_000),
});
await denied.body?.cancel();
assert.equal(denied.status, 401);
if (selected === 'browser') {
  const png = await call('/browser/screenshot', 'image/png', 2 * 1024 * 1024);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const pdf = await call('/browser/pdf', 'application/pdf', 2 * 1024 * 1024);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
}
if (selected === 'ai') {
  for (const route of ['direct', 'gateway']) {
    const output = await call(`/ai/${route}`, 'text/plain', 32 * 1024, {
      prompt: 'Describe the synthetic sample in one sentence.',
    });
    assert.ok(output.toString().trim().length > 0);
  }
}
if (selected === 'vpc') {
  const output = await call('/private-item', 'application/json', 4096);
  assert.deepEqual(JSON.parse(output.toString()), { id: 'sample', available: 3 });
}
if (selected === 'images') {
  for (const variant of ['thumbnail', 'card']) {
    const output = await call(`/images/${variant}`, 'image/webp', 512 * 1024);
    assert.equal(output.subarray(0, 4).toString(), 'RIFF');
    assert.equal(output.subarray(8, 12).toString(), 'WEBP');
  }
}
process.stdout.write(
  `${selected}: endpoint acceptance passed. Verify platform routing and service behavior using the README checklist.\n`,
);
