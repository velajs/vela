/* oxlint-disable no-await-in-loop -- Exercise request boundaries sequentially and consume each owned response. */
// @ts-expect-error Virtual module supplied by @cloudflare/vitest-plugin.
import * as test from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import worker from '../src/worker';
import { bytesStream, deferred, encoded, fixture, request } from './support';

const pool: {
  SELF: Fetcher;
  createExecutionContext(): ExecutionContext;
  waitOnExecutionContext(ctx: ExecutionContext): Promise<void>;
} = test;

// 1x1 synthetic PNG. No remote fetch, account access or R2 provisioning.
const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMIqFjwHwAE7AJoALDpKAAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

it('runs the Vela DI/auth pipeline and native local R2/Images transform', async () => {
  for (const path of ['/browser/pdf', '/ai/direct', '/private-item', '/images/card']) {
    const response = await pool.SELF.fetch(`https://composition.example${path}`, {
      method: path.startsWith('/ai/') ? 'POST' : 'GET',
    });
    expect(response.status).toBe(401);
    await response.arrayBuffer();
  }
  await env.MEDIA.put('owners/alpha/sample.png', png);
  try {
    const response = await pool.SELF.fetch(request('/images/thumbnail'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe('WEBP');
    expect(bytes.length).toBeLessThan(512 * 1024);
    expect(await env.IMAGES.info(new Response(bytes).body!)).toMatchObject({
      width: 128,
      height: 128,
    });
    expect((await pool.SELF.fetch(request('/images/card?owner=beta'))).status).toBe(400);
    const other = { ...env, DEMO_TOKEN: 'beta-token', DEMO_OWNER: 'beta' };
    const context = pool.createExecutionContext();
    const missing = await worker.fetch(
      request('/images/card', { headers: { authorization: 'Bearer beta-token' } }),
      other,
      context,
    );
    expect(missing.status).toBe(404);
    await missing.arrayBuffer();
    await pool.waitOnExecutionContext(context);
  } finally {
    await env.MEDIA.delete('owners/alpha/sample.png');
  }
});

it('isolates overlapping Vela environments and request-scoped bindings in workerd', async () => {
  const alpha = fixture();
  const beta = fixture('beta');
  const gate = deferred<Response>();
  alpha.fetch.mockReturnValue(gate.promise);
  const aCtx = pool.createExecutionContext();
  const bCtx = pool.createExecutionContext();
  const a = worker.fetch(request('/private-item'), { ...env, ...alpha.env }, aCtx);
  const b = worker.fetch(
    request('/private-item', { headers: { authorization: 'Bearer beta-token' } }),
    { ...env, ...beta.env },
    bCtx,
  );
  const bResponse = await b;
  expect(bResponse.status).toBe(200);
  await bResponse.arrayBuffer();
  gate.resolve(Response.json({ id: 'sample', available: 1 }));
  expect(await (await a).json()).toEqual({ id: 'sample', available: 1 });
  expect(alpha.fetch).toHaveBeenCalledTimes(1);
  expect(beta.fetch).toHaveBeenCalledTimes(1);
  const denied = await worker.fetch(request('/private-item'), { ...env, ...beta.env }, bCtx);
  expect(denied.status).toBe(401);
  await denied.arrayBuffer();
  await Promise.all([pool.waitOnExecutionContext(aCtx), pool.waitOnExecutionContext(bCtx)]);
});

it('compiles/runs Quick Actions and the real AI SDK/provider with explicit native doubles', async () => {
  const local = fixture();
  const bindings = { ...env, ...local.env };
  const context = pool.createExecutionContext();
  const browser = await worker.fetch(request('/browser/screenshot'), bindings, context);
  expect(browser.status).toBe(200);
  expect(new TextDecoder().decode(await browser.arrayBuffer())).toBe('png');
  const ai = await worker.fetch(
    request('/ai/gateway', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'Describe the sample briefly.' }),
    }),
    bindings,
    context,
  );
  expect(ai.status).toBe(200);
  expect(await ai.text()).toBe('alpha');
  expect(local.run).toHaveBeenCalledTimes(1);
  expect(local.run.mock.calls[0]![2]).toMatchObject({
    gateway: { id: 'alpha-gateway', skipCache: true },
  });
  await pool.waitOnExecutionContext(context);
});

it('rejects untrusted selectors at the HTTP boundary before native I/O', async () => {
  const local = fixture();
  const bindings = { ...env, ...local.env };
  const context = pool.createExecutionContext();
  for (const path of ['/browser/content', '/images/huge', '/private-item?url=https://evil.test']) {
    const response = await worker.fetch(request(path), bindings, context);
    expect(response.status).toBe(400);
    await response.arrayBuffer();
  }
  const invalidAi = await worker.fetch(
    request('/ai/direct', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'x', model: 'other' }),
    }),
    bindings,
    context,
  );
  expect(invalidAi.status).toBe(400);
  await invalidAi.arrayBuffer();
  expect(local.quickAction).not.toHaveBeenCalled();
  expect(local.run).not.toHaveBeenCalled();
  expect(local.get).not.toHaveBeenCalled();
  expect(local.fetch).not.toHaveBeenCalled();
  await pool.waitOnExecutionContext(context);
});

it('finishes request cleanup when a native HTTP stream consumer cancels AI output', async () => {
  const local = fixture();
  local.run.mockResolvedValue(bytesStream(encoded('data: {"response":"first"}\n\n'), false).stream);
  const context = pool.createExecutionContext();
  const response = await worker.fetch(
    request('/ai/direct', { method: 'POST', body: '{"prompt":"sample"}' }),
    { ...env, ...local.env },
    context,
  );
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
  await reader.cancel('disconnected');
  expect((local.run.mock.calls[0]![2] as AiOptions).signal!.aborted).toBe(true);
  await pool.waitOnExecutionContext(context);
});
