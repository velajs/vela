import { expect, it } from 'vitest';
import { captureHttpResult, parseHttpResult, replayHttpResult, fingerprintRequest } from '../http';
import { createIdempotency } from '../index';
import { createMemoryReliabilityStore } from '../testing';
import { claimed, scope } from './support';

it('captures bounded binary HTTP results, excludes sensitive headers and replays after persistence', async () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  const result = await captureHttpResult(
    new Response(bytes, {
      status: 201,
      headers: {
        'content-type': 'application/octet-stream',
        'set-cookie': 'secret=value',
        connection: 'x-secret',
        'x-secret': 'hidden',
      },
    }),
    { headers: ['content-type', 'set-cookie', 'x-secret'] },
  );
  const service = createIdempotency({
    store: createMemoryReliabilityStore(),
    parseResult: parseHttpResult,
  });
  const lease = claimed(await service.claim(scope, { key: 'http', fingerprint: 'binary' }));
  await service.complete(lease, result);
  const replay = await service.claim(scope, { key: 'http', fingerprint: 'binary' });
  expect(replay.kind).toBe('completed');
  if (replay.kind !== 'completed') throw new Error('Expected replay');
  const response = replayHttpResult(replay.value);
  expect(response.status).toBe(201);
  expect(response.headers.has('set-cookie')).toBe(false);
  expect(response.headers.has('x-secret')).toBe(false);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
});
it('stops oversized streams without buffering the rest and can persist an unavailable result', async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(16));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(captureHttpResult(new Response(body), { maxBodyBytes: 20 })).rejects.toMatchObject({
    code: 'RESULT_UNAVAILABLE',
  });
  expect(pulls).toBeLessThanOrEqual(3);
  expect(cancelled).toBe(true);
  const service = createIdempotency({
    store: createMemoryReliabilityStore(),
    parseResult: parseHttpResult,
  });
  const lease = claimed(await service.claim(scope, { key: 'too-big', fingerprint: 'body' }));
  await service.unavailable(lease);
  expect(await service.claim(scope, { key: 'too-big', fingerprint: 'body' })).toEqual({
    kind: 'failed',
    reason: 'result-unavailable',
  });
});
it('validates stored headers, status/body combinations, base64 and header budgets', async () => {
  expect(() => parseHttpResult({ status: 204, headers: [], body: 'YQ==' })).toThrow();
  expect(() =>
    parseHttpResult({ status: 200, headers: [['set-cookie', 'x=y']], body: '' }),
  ).toThrow();
  expect(() => parseHttpResult({ status: 200, headers: [], body: 'garbage===' })).toThrow();
  await expect(
    captureHttpResult(new Response('x', { headers: { 'content-type': 'x'.repeat(32) } }), {
      maxHeaderBytes: 10,
    }),
  ).rejects.toMatchObject({ code: 'RESULT_UNAVAILABLE' });
  await expect(
    captureHttpResult(
      new Response(new Uint8Array([1]), { headers: { 'content-encoding': 'gzip' } }),
    ),
  ).rejects.toMatchObject({ code: 'RESULT_UNAVAILABLE' });
  const empty = replayHttpResult(await captureHttpResult(new Response(null, { status: 204 })));
  expect(empty.body).toBeNull();
});
it('fingerprints bounded bytes with method, target and explicit principal scope while preserving the request', async () => {
  const request = new Request('https://example.test/items?a=1', {
    method: 'POST',
    body: 'request',
  });
  const first = await fingerprintRequest(request, {
    operation: 'create-item',
    principal: 'user-a',
  });
  expect(first).toMatch(/^[a-f0-9]{64}$/u);
  expect(
    await fingerprintRequest(request, { operation: 'create-item', principal: 'user-b' }),
  ).not.toBe(first);
  expect(await request.text()).toBe('request');
  await expect(
    fingerprintRequest(new Request('https://example.test', { method: 'POST', body: 'large' }), {
      operation: 'op',
      principal: 'p',
      maxBodyBytes: 2,
    }),
  ).rejects.toThrow('byte limit');
});
