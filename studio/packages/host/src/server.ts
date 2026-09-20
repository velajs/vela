/**
 * {@link startStudioServer} — the standalone `node:http` loopback dev host used
 * by `vela studio`. It binds a loopback interface, translates each `node:http`
 * request into a web `Request`, runs the shared {@link createStudioHandler}
 * core, and streams the web `Response` back to the socket.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createStudioHandler } from './handler';
import { resolveOptions } from './options';
import type { StudioHostOptions, StudioServer } from './types';

/** `RequestInit` extended with undici's `duplex`, required for a streamed body. */
interface StreamingRequestInit extends RequestInit {
  duplex?: 'half';
}

/** Build a web `Request` from an incoming `node:http` message (body streamed). */
function toWebRequest(req: IncomingMessage, host: string): Request {
  const authority = req.headers.host ?? host;
  const url = `http://${authority}${req.url ?? '/'}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const init: StreamingRequestInit = { method, headers };
  if (hasBody) {
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

/** Write a web `Response` to a `node:http` response, streaming the body. */
async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  for (const [key, value] of response.headers) {
    res.setHeader(key, value);
  }
  if (response.body === null) {
    res.end();
    return;
  }
  const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  try {
    // `pipeline` streams the body and closes `res`, propagating errors. A client
    // that disconnects mid-stream surfaces as a premature close — expected, not
    // a host fault, so it's swallowed.
    await pipeline(nodeStream, res);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      throw error;
    }
  }
}

/** Compose the user-facing loopback URL from the bound address + SPA base path. */
function buildUrl(address: AddressInfo, basePath: string): string {
  const host =
    address.address === '::' || address.address === '0.0.0.0' || address.address === '::1'
      ? '127.0.0.1'
      : address.address;
  const bracketed = host.includes(':') ? `[${host}]` : host;
  const suffix = basePath === '' ? '/' : basePath;
  return `http://${bracketed}:${String(address.port)}${suffix}`;
}

/**
 * Start the loopback dev host. Resolves once the socket is listening; the
 * returned {@link StudioServer} carries the URL to open and a `close()`.
 */
export async function startStudioServer(options: StudioHostOptions): Promise<StudioServer> {
  const resolved = resolveOptions(options);
  const handle = createStudioHandler(resolved);

  const server = createServer((req: IncomingMessage, res: ServerResponse): void => {
    const remoteAddress = req.socket.remoteAddress ?? undefined;
    void (async (): Promise<void> => {
      try {
        const request = toWebRequest(req, resolved.host);
        const response =
          (await handle(request, remoteAddress)) ??
          new Response('Not found', {
            status: 404,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        await writeWebResponse(response, res);
      } catch (error) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
        }
        const message = error instanceof Error ? error.message : String(error);
        res.end(`Studio host error: ${message}`);
      }
    })();
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(resolved.port, resolved.host, () => {
      server.off('error', rejectPromise);
      resolvePromise();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((r) => server.close(() => r()));
    throw new Error('Studio host failed to bind a TCP port.');
  }

  return {
    url: buildUrl(address, resolved.basePath),
    port: address.port,
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        // The `close` callback fires exactly once with either an error or none;
        // the two settle paths are mutually exclusive (linter can't prove it).
        // eslint-disable-next-line promise/no-multiple-resolved -- single-fire node callback
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      }),
  };
}
