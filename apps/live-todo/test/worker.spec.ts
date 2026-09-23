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
    expect(created.response.status).toBe(200);
    expect(created.body).toMatchObject({ text: 'Write the spec' });
    expect(created.response.headers.get('Vela-Commit-Cursor')).toBeTruthy();

    const listed = await call('/todos');
    expect(todoListDefinition.result.parse(listed.body).map((todo) => todo.text)).toContain(
      'Write the spec',
    );
  });
});
