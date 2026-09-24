import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { todoListDefinition } from '../src/live-contract';
import worker from '../src/worker';

/** Reads the body before waiting: the request finishes once its body is consumed. */
async function call(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`http://localhost:8789${path}`, init), env, ctx);
  const body: unknown = await response.json();
  await waitOnExecutionContext(ctx);
  return { response, body };
}

describe('live-todo Worker compiled by Oxc under workerd', () => {
  it('stores todos in KV and stamps each invalidation from the room Durable Object', async () => {
    const seeded = await call('/todos');
    expect(seeded.response.status).toBe(200);
    expect(todoListDefinition.result.parse(seeded.body)).toHaveLength(1);

    const created = await call('/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Write the spec' }),
    });
    // TodosController receives TodosService and LiveInvalidation from their
    // constructor types alone, so this route resolves only with the metadata.
    expect(created.response.status).toBe(201);
    expect(created.body).toMatchObject({ text: 'Write the spec' });
    expect(created.response.headers.get('Vela-Commit-Cursor')).toBeTruthy();

    const listed = await call('/todos');
    const todos = todoListDefinition.result.parse(listed.body);
    expect(todos.map((todo) => todo.text)).toContain('Write the spec');

    // @LiveInvalidates derives the delete's tags from its result: a missing
    // todo invalidates nothing, so its response carries no commit stamp.
    const missing = await call('/todos/missing', { method: 'DELETE' });
    expect(missing.body).toEqual({ removed: false });
    expect(missing.response.headers.get('Vela-Commit-Cursor')).toBeNull();
    const written = todos.find((todo) => todo.text === 'Write the spec');
    if (!written) throw new Error('the created todo is missing');
    const removed = await call(`/todos/${written.id}`, { method: 'DELETE' });
    expect(removed.body).toEqual({ removed: true });
    expect(Number(removed.response.headers.get('Vela-Commit-Cursor'))).toBeGreaterThan(
      Number(created.response.headers.get('Vela-Commit-Cursor')),
    );
  });

  it('admits a same-origin upgrade into the room Durable Object through the demo authenticator', async () => {
    const origin = 'http://localhost:8789';
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${origin}/rooms/default/ws`, { headers: { origin, upgrade: 'websocket' } }),
      env,
      ctx,
    );
    // A refusal carries a body, which must be read before the request finishes.
    if (response.status !== 101) await response.text();
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(101);
    response.webSocket?.accept();
    response.webSocket?.close(1000, 'done');
  });
});
