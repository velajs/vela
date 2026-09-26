import { HttpService, HttpRequestException, type HttpTransport } from '@velajs/vela/http-client';
import { z } from 'zod';
import { discard, privateHeaders } from './bounds';

export const privateDestination = 'https://catalog.internal.example/items/sample';
export const itemSchema = z
  .object({ id: z.literal('sample'), available: z.number().int().min(0).max(100) })
  .strict();

export async function readPrivateItem(env: Cloudflare.Env, request: Request): Promise<Response> {
  // A VPC Service binds the host/port in platform configuration. The URL supplies
  // Host/SNI and path; neither is client-controlled. VPC reachability is not app auth.
  const transport: HttpTransport = {
    fetch: (url, init) => env.PRIVATE_API.fetch(url, { ...init, redirect: 'manual' }),
  };
  const http = new HttpService({ transport, timeout: 3000, maxResponseBytes: 4096 });
  try {
    const result = await http.get(privateDestination, {
      schema: itemSchema,
      signal: request.signal,
    });
    return Response.json(result.data, { headers: privateHeaders });
  } catch (error) {
    // HttpService leaves non-2xx bodies to its caller; this route owns cleanup.
    if (error instanceof HttpRequestException) discard(error.response.body);
    throw error;
  }
}
