import { describe, expect, expectTypeOf, it } from 'vitest';
import { hc, parseResponse, withFormEncoding } from '../src/http';
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
  it('encodes declared form routes with repeated fields and preserves a custom transport and cancellation', async () => {
    type FormApp = HttpApp<{
      '/forms/:id': {
        $post: {
          input: { param: { id: string }; form: { tags: string[]; note?: string } };
          output: { ok: boolean };
          outputFormat: 'json';
          status: 200;
        };
      };
      '/files': {
        $post: {
          input: { form: { file: File | Blob; files?: Array<File | Blob> } };
          output: { ok: boolean };
          outputFormat: 'json';
          status: 200;
        };
      };
    }>;
    const requests: Request[] = [];
    const nativeTransport = {
      fetch: async function (input: RequestInfo | URL, init?: RequestInit) {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({ ok: true });
      },
    };
    const encodings = [
      { path: '/forms/:id', method: 'POST', contentType: 'application/x-www-form-urlencoded' },
      { path: '/files', method: 'POST', contentType: 'multipart/form-data' },
    ] as const;
    const transport = withFormEncoding(encodings, nativeTransport.fetch.bind(nativeTransport));
    const controller = new AbortController();
    const client = hc<FormApp>('https://example.test', {
      fetch: transport,
      headers: async () => ({ Authorization: 'Bearer example' }),
      init: { credentials: 'include' },
    });
    await client.forms[':id'].$post(
      { param: { id: 'one' }, form: { tags: ['a+b', 'é &='], note: undefined } },
      { init: { signal: controller.signal } },
    );
    expect(requests[0]!.headers.get('content-type')).toBe(
      'application/x-www-form-urlencoded;charset=UTF-8',
    );
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer example');
    expect(requests[0]!.credentials).toBe('include');
    expect(await requests[0]!.text()).toBe('tags=a%2Bb&tags=%C3%A9+%26%3D');
    controller.abort();
    expect(requests[0]!.signal.aborted).toBe(true);
    await client.files.$post(
      {
        form: {
          file: new Blob(['a']),
          files: [new File(['b'], 'b.txt'), new File(['c'], 'c.txt')],
        },
      },
      { fetch: transport },
    );
    expect(requests[1]!.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
    const form = await requests[1]!.formData();
    expect(form.getAll('files').map((value) => typeof value !== 'string' && value.name)).toEqual([
      'b.txt',
      'c.txt',
    ]);
    expect(form.get('file')).toBeInstanceOf(File);
  });

  it('refuses conflicting form headers and URL-encoded files, without changing unrelated requests', async () => {
    let calls = 0;
    const transport = withFormEncoding(
      [
        { path: '/encoded', method: 'POST', contentType: 'application/x-www-form-urlencoded' },
        { path: '/files', method: 'POST', contentType: 'multipart/form-data' },
      ],
      async (_input, init) => {
        calls++;
        return Response.json({ body: init?.body });
      },
    );
    const body = new FormData();
    body.append('file', new File(['x'], 'x.txt'));
    expect(() => transport('https://example.test/encoded', { method: 'POST', body })).toThrow(
      'cannot contain files',
    );
    expect(() =>
      transport('https://example.test/encoded', {
        method: 'POST',
        body,
        headers: { 'content-type': 'multipart/form-data' },
      }),
    ).toThrow('does not match');
    expect(() =>
      transport('https://example.test/files', {
        method: 'POST',
        body,
        headers: { 'content-type': 'multipart/form-data; boundary=wrong' },
      }),
    ).toThrow('boundary');
    expect(calls).toBe(0);
    await transport('https://example.test/other', { method: 'POST', body: 'json' });
    await transport('https://example.test/encoded', {
      method: 'POST',
      body: new URLSearchParams({ name: 'Ada' }),
    });
    expect(calls).toBe(2);
  });

  it('reports overlapping templates with different media types instead of guessing an encoding', () => {
    const transport = withFormEncoding([
      { path: '/forms/:id', method: 'POST', contentType: 'multipart/form-data' },
      { path: '/forms/new', method: 'POST', contentType: 'application/x-www-form-urlencoded' },
    ]);
    expect(() => transport('/forms/new', { method: 'POST', body: new FormData() })).toThrow(
      'Ambiguous form route encodings',
    );
  });
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
