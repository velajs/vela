import { HttpService, defineEndpoint, type EndpointResponseFormat } from '@velajs/vela';
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
const format: EndpointResponseFormat = 'stream';
defineEndpoint({ input: z.object({}), format }).bind(() => new ReadableStream<Uint8Array>());
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
