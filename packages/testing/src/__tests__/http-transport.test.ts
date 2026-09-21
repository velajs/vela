import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { createTestHttpClient } from '../http/test-http-client.js';

it('uses the same assertions with a real independently owned remote server', async () => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({ path: request.url, session: request.headers.authorization ?? null }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const baseUrl = `http://127.0.0.1:${address.port}/api/`;
    const first = createTestHttpClient({ baseUrl }).withHeaders({ authorization: 'first' });
    const second = createTestHttpClient({ baseUrl });
    const responses = await Promise.all([first.get('users').send(), second.get('users').send()]);
    expect(await Promise.all(responses.map((response) => response.assertOk().json()))).toEqual([
      { path: '/api/users', session: 'first' },
      { path: '/api/users', session: null },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
});

it('keeps injected transports and host headers local to each client', async () => {
  const fetch = vi.fn((request: Request) =>
    Response.json({ url: request.url, host: request.headers.get('host') }),
  );
  const client = createTestHttpClient({ baseUrl: 'https://worker.test/', fetch });
  const response = await client.forHost('tenant.test').get('/users').send();
  expect(await response.json()).toEqual({ url: 'https://tenant.test/users', host: 'tenant.test' });
  expect(await (await client.get('/users').send()).json()).toEqual({
    url: 'https://worker.test/users',
    host: null,
  });
});

it('does not retry failed mutations or pretend a remote target has local DI', async () => {
  const failure = new Error('connection reset after write');
  const fetch = vi.fn(async () => {
    throw failure;
  });
  const client = createTestHttpClient({ baseUrl: 'https://worker.test/', fetch });
  await expect(client.post('/users').withBody({ name: 'new' }).send()).rejects.toBe(failure);
  expect(fetch).toHaveBeenCalledTimes(1);
  await expect(client.get('/users').actingAs({ id: 'u1' }).send()).rejects.toThrow(
    'explicit headers',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(() => createTestHttpClient({ baseUrl: 'file:///tmp/worker' })).toThrow('http:');
});
