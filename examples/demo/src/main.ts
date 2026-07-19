/**
 * Runnable Node entry: boot the demo app and serve it on a loopback port, so
 * `vela studio --url http://localhost:<port>` can point at it (the admin surface
 * lives at `<url>/_vela/admin`). Drives the app's web-`fetch` handler through a
 * compact `node:http` bridge (no extra server dependency).
 *
 *   VELA_STUDIO_TOKEN=... PORT=8787 node dist/main.js
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ADMIN_BASE_PATH, createApp } from './create-app';

interface StreamingRequestInit extends RequestInit {
  duplex?: 'half';
}

function toWebRequest(req: IncomingMessage, host: string): Request {
  const authority = req.headers.host ?? host;
  const url = `http://${authority}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  const method = req.method ?? 'GET';
  const init: StreamingRequestInit = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  for (const [key, value] of response.headers) res.setHeader(key, value);
  if (response.body === null) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res);
}

async function main(): Promise<void> {
  const app = await createApp();
  const hono = app.getHonoApp();
  const port = Number(process.env.PORT ?? 8787);
  const host = '127.0.0.1';

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const response = await hono.fetch(toWebRequest(req, host));
        await writeWebResponse(response, res);
      } catch (error) {
        if (!res.headersSent) res.statusCode = 500;
        res.end(error instanceof Error ? error.message : String(error));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const url = `http://${host}:${String(port)}`;
  // eslint-disable-next-line no-console
  console.log(
    [
      `Vela Studio demo app listening on ${url}`,
      `  admin surface : ${url}${ADMIN_BASE_PATH}`,
      `  open Studio   : vela studio --url ${url}`,
    ].join('\n'),
  );
}

void main();
