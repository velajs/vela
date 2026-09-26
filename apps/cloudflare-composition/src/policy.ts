import { z } from 'zod';
import { RequestFailure, privateHeaders, readBytes } from './bounds';

// One principal per environment for this synthetic app. A token grants that owner's
// four operations. Replace this with verified user identity and permissions in a real app.
export function authorize(request: Request, env: Cloudflare.Env): string {
  if (!env.DEMO_TOKEN || request.headers.get('authorization') !== `Bearer ${env.DEMO_TOKEN}`)
    throw new RequestFailure(401, 'Unauthorized');
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(env.DEMO_OWNER))
    throw new RequestFailure(503, 'Invalid owner configuration');
  request.signal.throwIfAborted();
  return env.DEMO_OWNER;
}

export async function jsonInput(request: Request, signal: AbortSignal): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    throw new RequestFailure(415, 'Expected application/json');
  const bytes = await readBytes(request.body, 4096, signal);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new RequestFailure(400, 'Invalid JSON');
  }
}

export function noQuery(request: Request): void {
  if (new URL(request.url).search) throw new RequestFailure(400, 'Unexpected query parameters');
}

export async function authorized(
  request: Request,
  env: Cloudflare.Env,
  run: (owner: string) => Promise<Response>,
): Promise<Response> {
  try {
    const owner = authorize(request, env);
    noQuery(request);
    return await run(owner);
  } catch (error) {
    const status =
      error instanceof RequestFailure
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : error instanceof DOMException && error.name === 'TimeoutError'
            ? 504
            : request.signal.aborted
              ? 499
              : 502;
    // Never return upstream errors, internal hostnames, credentials or prompt contents.
    const message =
      status === 401 ? 'Unauthorized' : status < 500 ? 'Invalid request' : 'Operation failed';
    return new Response(message, { status, headers: privateHeaders });
  }
}
