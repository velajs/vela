import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { LiveClient } from '../src/live-client';

function parseUser(value: unknown): { id: string } {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('id' in value) ||
    typeof value.id !== 'string'
  )
    throw new Error('Invalid user response');
  return { id: value.id };
}

describe('mutation result evidence', () => {
  it('infers results from a parser and keeps raw responses unknown', async () => {
    const client = new LiveClient({
      queries: {},
      url: 'https://api.test',
      fetch: async () => Response.json({ id: 'u1' }),
    });
    const raw = await client.mutate('/users', {});
    expectTypeOf(raw).toBeUnknown();
    const user = await client.mutate('/users', {}, { parseResult: parseUser });
    expectTypeOf(user).toEqualTypeOf<{ id: string }>();
    expect(user.id).toBe('u1');
    const asyncUser = await client.mutate(
      '/users',
      {},
      { parseResult: async (value) => parseUser(value) },
    );
    expectTypeOf(asyncUser).toEqualTypeOf<{ id: string }>();
    client.close();
  });

  it('does not replay a committed write when its result parser rejects', async () => {
    const fetch = vi.fn(async () => Response.json({ id: 42 }));
    const client = new LiveClient({
      queries: {},
      url: 'https://api.test',
      fetch,
      identity: () => 'account:epoch',
      offline: true,
    });
    await expect(client.mutate('/users', {}, { parseResult: parseUser })).rejects.toThrow(
      'Invalid user response',
    );
    expect(client.pendingMutations()).toBe(0);
    await client.flush();
    expect(fetch).toHaveBeenCalledOnce();
    client.close();
  });

  it('parses the result of an offline replay for the original awaiter', async () => {
    const client = new LiveClient({
      queries: {},
      url: 'https://api.test',
      identity: () => 'account:epoch',
      offline: { queueBeforeFirstConnect: true },
      fetch: async () => Response.json({ id: 'queued' }),
    });
    const pending = client.mutate('/users', {}, { parseResult: parseUser });
    expect(client.pendingMutations()).toBe(1);
    await client.flush();
    await expect(pending).resolves.toEqual({ id: 'queued' });
    client.close();
  });
});

// Compiled but never executed: a type argument alone is not result evidence.
function mutationTypeErrors(client: LiveClient): void {
  // @ts-expect-error a typed result requires a parser
  client.mutate<{ id: string }>('/users', {});
  // @ts-expect-error the parser's output must match the explicit result type
  client.mutate<{ id: number }>('/users', {}, { parseResult: parseUser });
}
void mutationTypeErrors;
