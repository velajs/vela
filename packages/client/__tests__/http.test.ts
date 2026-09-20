import { describe, expect, expectTypeOf, it } from 'vitest';
import { hc, parseResponse } from '../src/http';
import type {
  ApplyGlobalResponse,
  HttpApp,
  InferRequestType,
  InferResponseType,
} from '../src/http';

type User = { id: string; name: string };
type AppType = HttpApp<{
  '/users/:id': {
    $get:
      | {
          input: { param: { id: string }; query?: { expand?: string[] } };
          output: User;
          outputFormat: 'json';
          status: 200;
        }
      | {
          input: { param: { id: string }; query?: { expand?: string[] } };
          output: { error: string };
          outputFormat: 'json';
          status: 404;
        };
  };
  '/users': {
    $post: { input: { json: { name: string } }; output: User; outputFormat: 'json'; status: 201 };
  };
}>;

describe('HTTP entry point', () => {
  it('uses hc request semantics and preserves fetch options', async () => {
    const requests: Request[] = [];
    const controller = new AbortController();
    const client = hc<AppType>('https://example.com/api', {
      headers: async () => ({ Authorization: 'Bearer test' }),
      init: { credentials: 'include' },
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json(
          { id: 'u1', name: 'Ada' },
          { status: request.method === 'POST' ? 201 : 200 },
        );
      },
    });
    const res = await client.users[':id'].$get({
      param: { id: 'u1' },
      query: { expand: ['team', 'roles'] },
    });
    expect(await res.json()).toEqual({ id: 'u1', name: 'Ada' });
    expect(requests[0]?.url).toBe('https://example.com/api/users/u1?expand=team&expand=roles');
    expect(requests[0]?.headers.get('Authorization')).toBe('Bearer test');
    expect(requests[0]?.credentials).toBe('include');
    const user = await parseResponse(
      client.users.$post({ json: { name: 'Ada' } }, { init: { signal: controller.signal } }),
    );
    expect(user.name).toBe('Ada');
    expect(await requests[1]?.json()).toEqual({ name: 'Ada' });
    expect(requests[1]?.method).toBe('POST');
    controller.abort();
    expect(requests[1]?.signal.aborted).toBe(true);
    expect(client.users[':id'].$url({ param: { id: 'u1' } }).pathname).toBe('/api/users/u1');
  });

  it('keeps unsuccessful responses available for status narrowing', async () => {
    const client = hc<AppType>('https://example.com', {
      fetch: async () => Response.json({ error: 'missing' }, { status: 404 }),
    });
    const response = await client.users[':id'].$get({ param: { id: 'absent' } });
    if (response.status === 404) {
      const data = await response.json();
      expectTypeOf(data).toEqualTypeOf<{ error: string }>();
      expect(data).toEqual({ error: 'missing' });
    } else {
      expectTypeOf(await response.json()).toEqualTypeOf<User>();
    }
    await expect(
      parseResponse(client.users[':id'].$get({ param: { id: 'absent' } })),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('infers request, success and global error types', () => {
    const client = hc<ApplyGlobalResponse<AppType, { 401: { json: { message: string } } }>>('/');
    expectTypeOf<InferRequestType<typeof client.users.$post>>().toEqualTypeOf<{
      json: { name: string };
    }>();
    expectTypeOf<InferResponseType<typeof client.users.$post, 201>>().toEqualTypeOf<User>();
    expectTypeOf<InferResponseType<typeof client.users.$post, 401>>().toEqualTypeOf<{
      message: string;
    }>();
    // Type assertions are compiled by tsc; never execute these invalid requests.
    if (false) {
      // @ts-expect-error unknown route
      client.missing.$get();
      // @ts-expect-error unknown HTTP method
      client.users.$delete();
      // @ts-expect-error missing required path parameter
      client.users[':id'].$get();
      // @ts-expect-error wrong request body
      client.users.$post({ json: { name: 123 } });
    }
  });
});
