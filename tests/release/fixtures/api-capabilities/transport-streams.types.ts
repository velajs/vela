import { HttpService } from '@velajs/vela/http-client';
import { Get, type RouteResponseFormat } from '@velajs/vela';
import { createHttpClientTelemetryObserver, noopTelemetry } from '@velajs/vela/observability';
import { hc, readHttpResponse, type HttpResponse } from '@velajs/client/http';
import type { AppType } from './generated-streams';
import { z } from 'zod';

const http = new HttpService({
  observer: createHttpClientTelemetryObserver({ telemetry: noopTelemetry }),
});
const decoded = http.get('/value', { schema: z.object({ value: z.string().transform(Number) }) });
void decoded.then((response) => {
  const value: number = response.data.value;
  // @ts-expect-error Schema transformations determine the result type.
  const wrong: string = response.data.value;
  return [value, wrong];
});
const format: RouteResponseFormat = 'stream';
class Streams {
  @Get('/stream', { format: 'stream' })
  stream() {
    return new ReadableStream<Uint8Array>();
  }

  // @ts-expect-error A stream route returns a ReadableStream or a Response.
  @Get('/wrong', { format: 'stream' })
  wrong() {
    return 'text';
  }
}
void [format, Streams];
const client = hc<AppType>('https://fixture.test');
const response: Promise<HttpResponse<206>> = readHttpResponse(
  client.transfers.bytes.$get(),
  'response',
);
void response.then(async (value) => {
  const unknown: unknown = await value.json();
  // @ts-expect-error Native bytes do not acquire an arbitrary JSON shape.
  const wrong: { id: string } = await value.json();
  return [unknown, wrong];
});
