import { vi } from 'vitest';

export function bytesStream(bytes: Uint8Array, close = true) {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      if (close) controller.close();
    },
    cancel,
  });
  return { stream, cancel };
}
export const encoded = (text: string) => new TextEncoder().encode(text);
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function request(path: string, options: RequestInit = {}) {
  return new Request(`https://composition.example${path}`, {
    ...options,
    headers: {
      authorization: 'Bearer alpha-token',
      'content-type': 'application/json',
      ...options.headers,
    },
  });
}

// Deliberately partial native doubles. Production code is checked separately against
// the complete Wrangler-generated binding types and compiled/run in workerd.
export function fixture(owner = 'alpha') {
  const quickAction = vi.fn(
    async (_action: string, _options: unknown) =>
      new Response('png', { headers: { 'content-type': 'image/png' } }),
  );
  const run = vi.fn(
    async (_model: string, _input: unknown, _options: unknown) =>
      bytesStream(encoded(`data: {"response":"${owner}"}\n\ndata: [DONE]\n\n`)).stream,
  );
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ id: 'sample', available: 3 }),
  );
  const get = vi.fn(async (_key: string) => ({
    size: 3,
    body: bytesStream(encoded('png')).stream,
  }));
  const output = vi.fn(async (_options: unknown) => ({
    response: () => new Response('webp', { headers: { 'content-type': 'image/webp' } }),
  }));
  const transform = vi.fn((_options: unknown) => ({ output }));
  const input = vi.fn((_body: ReadableStream<Uint8Array>) => ({ transform }));
  const env = {
    DEMO_OWNER: owner,
    DEMO_TOKEN: `${owner}-token`,
    AI_GATEWAY_ID: `${owner}-gateway`,
    BROWSER: { quickAction },
    AI: { run },
    PRIVATE_API: { fetch },
    MEDIA: { get },
    IMAGES: { input },
  } as unknown as Cloudflare.Env;
  return { env, quickAction, run, fetch, get, output, transform, input };
}
