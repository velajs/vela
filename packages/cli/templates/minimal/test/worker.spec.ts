import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/worker.js';

describe('worker', () => {
  it('answers GET / with the injected service message', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request('http://localhost/'), env, ctx);
    // Read the body before waiting: the request finishes once its body is consumed.
    const body = await response.json();
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(body).toEqual({ message: 'Hello from Vela!' });
  });
});
