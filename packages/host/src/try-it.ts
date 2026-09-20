import { isRecord, parseTryItRequest } from '@velajs/studio-protocol';
import type { TryItResponse } from '@velajs/studio-protocol';
import { HOP_BY_HOP_HEADERS } from './constants';
import type { ResolvedOptions } from './options';

const failure = (status: number, message: string): Response =>
  Response.json({ message }, { status });

/** Only explicit API headers cross this boundary; the browser/admin request never does. */
export async function executeApiRequest(
  request: Request,
  options: ResolvedOptions,
): Promise<Response> {
  if (request.method !== 'POST') return failure(405, 'Use POST for API requests.');
  let args: ReturnType<typeof parseTryItRequest>;
  try {
    args = parseTryItRequest(await request.json());
  } catch (error) {
    return failure(400, error instanceof Error ? error.message : 'Invalid API request.');
  }

  const target = new URL(args.path, options.workerOrigin);
  let pathname: string;
  try {
    pathname = new URL(decodeURIComponent(target.pathname), options.workerOrigin).pathname;
  } catch {
    return failure(400, 'Invalid request path.');
  }
  if (
    target.origin !== options.workerOrigin ||
    pathname === options.adminPath ||
    pathname.startsWith(`${options.adminPath}/`)
  ) {
    return failure(403, 'The Studio admin surface cannot be called from the API explorer.');
  }
  for (const [key, value] of Object.entries(args.query ?? {})) target.searchParams.set(key, value);
  const headers = new Headers();
  try {
    for (const [key, value] of Object.entries(args.headers ?? {})) {
      const name = key.toLowerCase();
      if (
        HOP_BY_HOP_HEADERS.has(name) ||
        name === 'host' ||
        name === 'content-length' ||
        name.startsWith('proxy-') ||
        name.startsWith('sec-') ||
        name.startsWith('x-forwarded-')
      ) {
        return failure(400, `Header ${key} is managed by the HTTP transport.`);
      }
      if (
        value.includes(options.sessionToken) ||
        (options.adminToken && value.includes(options.adminToken))
      ) {
        return failure(400, 'Studio credentials cannot be used as API credentials.');
      }
      headers.set(key, value);
    }
  } catch {
    return failure(400, 'Invalid request headers.');
  }

  const doFetch = options.fetchImpl ?? fetch;
  try {
    // Worker owns authorization, editable gates and the audit record. It never dispatches the API.
    const authorized = await doFetch(
      `${options.workerOrigin}${options.adminPath}/rpc/api.authorizeTryIt`,
      {
        method: 'POST',
        redirect: 'manual',
        signal: request.signal,
        headers: {
          'content-type': 'application/json',
          ...(options.adminToken ? { authorization: `Bearer ${options.adminToken}` } : {}),
        },
        body: JSON.stringify({
          args: { method: args.method, path: target.pathname + target.search },
        }),
      },
    );
    const permission: unknown = await authorized.json();
    if (
      !authorized.ok ||
      !isRecord(permission) ||
      permission.ok !== true ||
      !isRecord(permission.data) ||
      permission.data.authorized !== true
    ) {
      return failure(
        authorized.status === 401 || authorized.status === 403 ? authorized.status : 502,
        'Worker did not authorize this API request. Check Studio configuration and opsEditable.',
      );
    }

    const init: RequestInit = {
      method: args.method,
      headers,
      redirect: 'manual',
      signal: request.signal,
    };
    if (args.method !== 'GET' && args.method !== 'HEAD' && args.body !== undefined) {
      init.body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }
    const response = await doFetch(target, init);
    const text = await response.text();
    let body: unknown = text || null;
    if (text && /application\/json|\+json/.test(response.headers.get('content-type') ?? '')) {
      try {
        body = JSON.parse(text);
      } catch {
        /* Display non-JSON body verbatim. */
      }
    }
    const result: TryItResponse = {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body,
    };
    // Set-Cookie is response data, never a browser response header. Redirects are displayed, not followed.
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return failure(502, 'Studio host could not reach the Worker.');
  }
}
