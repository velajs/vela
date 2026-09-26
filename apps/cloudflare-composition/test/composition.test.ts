/* oxlint-disable no-await-in-loop -- Exercise request boundaries sequentially and consume each owned response. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answer, modelId, sampleTool, sampleToolInput } from '../src/ai';
import { renderPage } from '../src/browser';
import { renderImage } from '../src/images';
import { authorized } from '../src/policy';
import { privateDestination, readPrivateItem } from '../src/private-service';
import { bytesStream, deferred, encoded, fixture, request } from './support';

afterEach(() => vi.useRealTimers());

describe('application authorization and parameters', () => {
  it('prevents binding work for already aborted operations', async () => {
    const local = fixture();
    const controller = new AbortController();
    const reason = new Error('already disconnected');
    controller.abort(reason);
    const input = request('/unused', { signal: controller.signal });
    await expect(renderPage(local.env, 'pdf', input)).rejects.toBe(reason);
    await expect(readPrivateItem(local.env, input)).rejects.toBe(reason);
    await expect(renderImage(local.env, 'alpha', 'card', input)).rejects.toBe(reason);
    await expect(
      answer(
        local.env,
        'alpha',
        'direct',
        request('/ai/direct', {
          method: 'POST',
          body: '{"prompt":"sample"}',
          signal: controller.signal,
        }),
      ),
    ).rejects.toBe(reason);
    expect(local.quickAction).not.toHaveBeenCalled();
    expect(local.fetch).not.toHaveBeenCalled();
    expect(local.get).not.toHaveBeenCalled();
    expect(local.run).not.toHaveBeenCalled();
  });
  it('fails closed for missing/wrong secrets before calling any binding', async () => {
    const { env } = fixture();
    const operation = vi.fn();
    for (const token of ['', 'beta-token']) {
      expect(
        (
          await authorized(
            request('/private-item', { headers: { authorization: `Bearer ${token}` } }),
            env,
            operation,
          )
        ).status,
      ).toBe(401);
    }
    expect(
      (await authorized(request('/private-item'), { ...env, DEMO_TOKEN: '' }, operation)).status,
    ).toBe(401);
    expect(operation).not.toHaveBeenCalled();
  });
  it('rejects URL/key/owner/query overrides and invalid environment owners', async () => {
    const { env } = fixture();
    const operation = vi.fn();
    expect((await authorized(request('/images/card?owner=beta'), env, operation)).status).toBe(400);
    expect(
      (await authorized(request('/images/card'), { ...env, DEMO_OWNER: '../beta' }, operation))
        .status,
    ).toBe(503);
    expect(operation).not.toHaveBeenCalled();
  });
});

describe('native Quick Actions composition', () => {
  it.each(['screenshot', 'pdf'])('owns the destination and bounds for %s', async (format) => {
    const { env, quickAction } = fixture();
    const contentType = format === 'pdf' ? 'application/pdf' : 'image/png';
    quickAction.mockResolvedValue(
      new Response('bytes', { headers: { 'content-type': contentType } }),
    );
    const response = await renderPage(env, format, request(`/browser/${format}`));
    expect(await response.text()).toBe('bytes');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const [action, options] = quickAction.mock.calls[0]!;
    expect(action).toBe(format);
    expect(options).toMatchObject({
      url: 'https://example.com/',
      allowResourceTypes: ['document'],
      setJavaScriptEnabled: false,
      cacheTTL: 0,
    });
    const pattern = new RegExp((options as BrowserRunBaseOptions).allowRequestPattern![0]!);
    expect(pattern.test('https://example.com/')).toBe(true);
    for (const url of [
      'https://example.com.evil.test/',
      'https://example.com/private',
      'http://127.0.0.1/',
      'https://example.com/?next=evil',
    ])
      expect(pattern.test(url)).toBe(false);
    expect(options).not.toHaveProperty('authenticate');
    expect(options).not.toHaveProperty('setExtraHTTPHeaders');
    expect(options).not.toHaveProperty('cookies');
  });
  it('rejects arbitrary actions before I/O', async () => {
    const { env, quickAction } = fixture();
    await expect(renderPage(env, 'content', request('/browser/content'))).rejects.toThrow();
    expect(quickAction).not.toHaveBeenCalled();
  });
  it.each([429, 500])('discards upstream error bodies (%s)', async (status) => {
    const { env, quickAction } = fixture();
    const body = bytesStream(encoded('private provider error'), false);
    quickAction.mockResolvedValue(new Response(body.stream, { status }));
    await expect(renderPage(env, 'pdf', request('/browser/pdf'))).rejects.toThrow(
      'Browser rendering failed',
    );
    expect(body.cancel).toHaveBeenCalled();
  });
  it('bounds actual output bytes even without a length header', async () => {
    const { env, quickAction } = fixture();
    const body = bytesStream(new Uint8Array(2 * 1024 * 1024 + 1), false);
    quickAction.mockResolvedValue(
      new Response(body.stream, { headers: { 'content-type': 'image/png' } }),
    );
    await expect(renderPage(env, 'screenshot', request('/browser/screenshot'))).rejects.toThrow(
      'Byte limit',
    );
    expect(body.cancel).toHaveBeenCalled();
  });
  it('stops waiting on abort and discards late native output', async () => {
    const { env, quickAction } = fixture();
    const pending = deferred<Response>();
    quickAction.mockReturnValue(pending.promise);
    const abort = new AbortController();
    const rendered = renderPage(env, 'pdf', request('/browser/pdf', { signal: abort.signal }));
    const reason = new Error('client left');
    abort.abort(reason);
    await expect(rendered).rejects.toBe(reason);
    const body = bytesStream(encoded('late'), false);
    pending.resolve(new Response(body.stream));
    await vi.waitFor(() => expect(body.cancel).toHaveBeenCalled());
  });
  it('enforces the local wait deadline without claiming session cancellation', async () => {
    vi.useFakeTimers();
    const { env, quickAction } = fixture();
    quickAction.mockReturnValue(new Promise(() => {}));
    const result = renderPage(env, 'pdf', request('/browser/pdf'));
    const assertion = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('VPC through HttpService', () => {
  it('uses one fixed service destination, validates data and never forwards user auth', async () => {
    const { env, fetch } = fixture();
    expect(await (await readPrivateItem(env, request('/private-item'))).json()).toEqual({
      id: 'sample',
      available: 3,
    });
    expect(fetch.mock.calls[0]![0]).toBe(privateDestination);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).has('authorization')).toBe(false);
    fetch.mockResolvedValue(Response.json({ id: 'other', available: -1 }));
    await expect(readPrivateItem(env, request('/private-item'))).rejects.toThrow();
  });
  it('does not follow redirects and cancels the error body', async () => {
    const { env, fetch } = fixture();
    const body = bytesStream(encoded('redirect'), false);
    fetch.mockResolvedValue(
      new Response(body.stream, { status: 302, headers: { location: 'https://evil.test' } }),
    );
    await expect(readPrivateItem(env, request('/private-item'))).rejects.toMatchObject({
      status: 302,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(body.cancel).toHaveBeenCalled();
  });
  it('cancels oversized and aborted response readers', async () => {
    const { env, fetch } = fixture();
    const oversized = bytesStream(new Uint8Array(4097), false);
    fetch.mockResolvedValue(new Response(oversized.stream));
    await expect(readPrivateItem(env, request('/private-item'))).rejects.toThrow();
    expect(oversized.cancel).toHaveBeenCalled();
    const body = bytesStream(encoded('{'), false);
    fetch.mockResolvedValue(new Response(body.stream));
    const abort = new AbortController();
    const result = readPrivateItem(env, request('/private-item', { signal: abort.signal }));
    await vi.waitFor(() => expect(body.stream.locked).toBe(true));
    const reason = new Error('disconnected');
    abort.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(body.cancel).toHaveBeenCalled();
  });
  it('times out an uncooperative transport, then cancels its late response', async () => {
    vi.useFakeTimers();
    const { env, fetch } = fixture();
    const pending = deferred<Response>();
    fetch.mockReturnValue(pending.promise);
    const result = readPrivateItem(env, request('/private-item'));
    const assertion = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
    expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    const body = bytesStream(encoded('late'), false);
    pending.resolve(new Response(body.stream));
    await vi.advanceTimersByTimeAsync(0);
    expect(body.cancel).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('authorized R2 to Images composition', () => {
  it('discards late transform output after aborting the local wait', async () => {
    const { env, output } = fixture();
    const pending = deferred<{ response: () => Response }>();
    output.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const rendered = renderImage(
      env,
      'alpha',
      'card',
      request('/images/card', { signal: controller.signal }),
    );
    await vi.waitFor(() => expect(output).toHaveBeenCalled());
    controller.abort(new Error('gone'));
    await expect(rendered).rejects.toThrow('gone');
    const result = bytesStream(encoded('webp'), false);
    pending.resolve({ response: () => new Response(result.stream) });
    await vi.waitFor(() => expect(result.cancel).toHaveBeenCalled());
  });
  it('selects only the authorized owner key and fixed transform', async () => {
    const { env, get, transform, output, input } = fixture();
    const response = await renderImage(env, 'alpha', 'card', request('/images/card'));
    expect(await response.text()).toBe('webp');
    expect(get).toHaveBeenCalledWith('owners/alpha/sample.png');
    expect(transform).toHaveBeenCalledWith({ width: 640, height: 360, fit: 'contain' });
    expect(output).toHaveBeenCalledWith({ format: 'image/webp', quality: 75, anim: false });
    expect(input).toHaveBeenCalledTimes(1);
    expect((await input.mock.calls[0]![0].getReader().read()).done).toBe(true);
  });
  it('rejects arbitrary transform names without storage access', async () => {
    const { env, get } = fixture();
    await expect(renderImage(env, 'alpha', '4096', request('/images/4096'))).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });
  it('cancels an oversized R2 body before transformation', async () => {
    const { env, get, input } = fixture();
    const body = bytesStream(encoded('png'), false);
    get.mockResolvedValue({ size: 1024 * 1024 + 1, body: body.stream });
    await expect(renderImage(env, 'alpha', 'card', request('/images/card'))).rejects.toThrow(
      'Input image too large',
    );
    expect(body.cancel).toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
  });
  it('counts actual R2 bytes even with incorrect metadata and limits output', async () => {
    const { env, get, input, output } = fixture();
    const source = bytesStream(new Uint8Array(1024 * 1024 + 1), false);
    get.mockResolvedValueOnce({ size: 3, body: source.stream });
    await expect(renderImage(env, 'alpha', 'card', request('/images/card'))).rejects.toThrow(
      'Byte limit',
    );
    expect(source.cancel).toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
    const result = bytesStream(new Uint8Array(512 * 1024 + 1), false);
    output.mockResolvedValue({
      response: () => new Response(result.stream, { headers: { 'content-type': 'image/webp' } }),
    });
    await expect(renderImage(env, 'alpha', 'card', request('/images/card'))).rejects.toThrow(
      'Byte limit',
    );
    expect(result.cancel).toHaveBeenCalled();
  });
  it('surfaces transform failure after fully consuming the bounded R2 input', async () => {
    const { env, get, output } = fixture();
    const source = new Response('png');
    get.mockResolvedValue({ size: 3, body: source.body! });
    output.mockRejectedValue(new Error('native failure'));
    await expect(renderImage(env, 'alpha', 'card', request('/images/card'))).rejects.toThrow(
      'native failure',
    );
    expect(source.bodyUsed).toBe(true);
  });
  it('cancels a late R2 result after request abort', async () => {
    const { env, get, input } = fixture();
    const pending = deferred<{ size: number; body: ReadableStream<Uint8Array> }>();
    get.mockReturnValue(pending.promise);
    const abort = new AbortController();
    const result = renderImage(
      env,
      'alpha',
      'card',
      request('/images/card', { signal: abort.signal }),
    );
    abort.abort(new DOMException('gone', 'AbortError'));
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    const body = bytesStream(encoded('png'), false);
    pending.resolve({ size: 3, body: body.stream });
    await vi.waitFor(() => expect(body.cancel).toHaveBeenCalled());
    expect(input).not.toHaveBeenCalled();
  });
});

describe('Workers AI / AI Gateway with the real upstream provider and SDK', () => {
  it('enforces the response deadline while inference ignores its abort signal', async () => {
    vi.useFakeTimers();
    const { env, run } = fixture();
    run.mockReturnValue(new Promise(() => {}));
    const response = await answer(
      env,
      'alpha',
      'direct',
      request('/ai/direct', {
        method: 'POST',
        body: '{"prompt":"sample"}',
      }),
    );
    const text = response.text();
    const assertion = expect(text).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect((run.mock.calls[0]![2] as AiOptions).signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('isolates overlapping environment bindings, prompts and gateway settings', async () => {
    const alpha = fixture();
    const beta = fixture('beta');
    const gate = deferred<ReadableStream<Uint8Array>>();
    alpha.run.mockReturnValue(gate.promise);
    const a = await answer(
      alpha.env,
      'alpha',
      'direct',
      request('/ai/direct', { method: 'POST', body: JSON.stringify({ prompt: 'alpha question' }) }),
    );
    const textA = a.text();
    await vi.waitFor(() => expect(alpha.run).toHaveBeenCalled());
    const b = await answer(
      beta.env,
      'beta',
      'gateway',
      request('/ai/gateway', { method: 'POST', body: JSON.stringify({ prompt: 'beta question' }) }),
    );
    expect(await b.text()).toBe('beta');
    gate.resolve(bytesStream(encoded('data: {"response":"alpha"}\n\ndata: [DONE]\n\n')).stream);
    expect(await textA).toBe('alpha');
    expect(alpha.run.mock.calls[0]![0]).toBe(modelId);
    expect(alpha.run.mock.calls[0]![1]).toMatchObject({ max_tokens: 256, stream: true });
    expect(alpha.run.mock.calls[0]![2]).toMatchObject({ gateway: undefined });
    expect(beta.run.mock.calls[0]![2]).toMatchObject({
      gateway: { id: 'beta-gateway', skipCache: true },
    });
    expect(JSON.stringify(alpha.run.mock.calls)).not.toContain('beta question');
    expect(JSON.stringify(beta.run.mock.calls)).not.toContain('alpha question');
  });
  it.each([
    { prompt: 'x', model: 'anything' },
    { prompt: 'x', gateway: 'attacker' },
    { prompt: '' },
    { prompt: 'x'.repeat(2049) },
    { messages: [] },
  ])('rejects untrusted model/config/input before inference: %j', async (body) => {
    const { env, run } = fixture();
    await expect(
      answer(
        env,
        'alpha',
        'direct',
        request('/ai/direct', { method: 'POST', body: JSON.stringify(body) }),
      ),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it('bounds streaming request bodies before JSON parsing', async () => {
    const { env, run } = fixture();
    const body = bytesStream(new Uint8Array(4097), false);
    const input = new Request('https://composition.example/ai/direct', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body.stream,
      duplex: 'half',
    } as RequestInit);
    await expect(answer(env, 'alpha', 'direct', input)).rejects.toThrow('Byte limit');
    expect(body.cancel).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  it('validates tool arguments and keeps owner outside model control', async () => {
    expect(sampleToolInput.safeParse({ id: 'sample', owner: 'beta' }).success).toBe(false);
    expect(sampleToolInput.safeParse({ id: 'secret' }).success).toBe(false);
    const tool = sampleTool('alpha', new AbortController().signal);
    expect(
      await tool.execute!({ id: 'sample' }, { toolCallId: 'one', messages: [], context: {} }),
    ).toEqual({ id: 'sample', owner: 'alpha', available: 3 });
  });
  it('propagates downstream cancellation to the SDK/native signal', async () => {
    const { env, run } = fixture();
    const upstream = bytesStream(encoded('data: {"response":"first"}\n\n'), false);
    run.mockResolvedValue(upstream.stream);
    const response = await answer(
      env,
      'alpha',
      'direct',
      request('/ai/direct', { method: 'POST', body: '{"prompt":"sample"}' }),
    );
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
    const signal = (run.mock.calls[0]![2] as AiOptions).signal!;
    await reader.cancel('client disconnected');
    expect(signal.aborted).toBe(true);
    // This provider does not promise cancelling its bare native SSE reader.
    // Signal forwarding is verified; upstream inference cancellation is not.
    expect(signal.reason).toBe('client disconnected');
  });
  it('cancels output above the application byte limit', async () => {
    const { env, run } = fixture();
    const upstream = bytesStream(
      encoded(`data: ${JSON.stringify({ response: 'x'.repeat(32 * 1024 + 1) })}\n\n`),
      false,
    );
    run.mockResolvedValue(upstream.stream);
    const response = await answer(
      env,
      'alpha',
      'direct',
      request('/ai/direct', { method: 'POST', body: '{"prompt":"sample"}' }),
    );
    await expect(response.text()).rejects.toThrow('Byte limit');
    expect((run.mock.calls[0]![2] as AiOptions).signal!.aborted).toBe(true);
  });
  it('reports provider failure without retrying or leaving a deadline timer', async () => {
    vi.useFakeTimers();
    const { env, run } = fixture();
    run.mockRejectedValue(new Error('inference failed'));
    const response = await answer(
      env,
      'alpha',
      'direct',
      request('/ai/direct', { method: 'POST', body: '{"prompt":"sample"}' }),
    );
    await expect(response.text()).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
