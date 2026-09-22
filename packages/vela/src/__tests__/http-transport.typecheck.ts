import { z } from 'zod';
import * as v from 'valibot';
import {
  HttpService,
  type HttpFetch,
  type HttpTransport,
  type RequestConfig,
  type HttpResponse,
} from '../fetch';
import { defineDto, type StandardSchemaV1 } from '../validation';

const transformed = z.object({ value: z.string().transform(Number) });
const standard = v.object({ value: v.pipe(v.string(), v.transform(Number)) });
const descriptor = defineDto(transformed);

export async function checkHttpResponseInference(http: HttpService): Promise<void> {
  const get: HttpResponse<{ value: number }> = await http.get('/items', { schema: transformed });
  const post: HttpResponse<{ value: number }> = await http.post('/items', {}, { schema: standard });
  const put: HttpResponse<{ value: number }> = await http.put('/items', {}, { schema: descriptor });
  const patch: HttpResponse<{ value: number }> = await http.patch(
    '/items',
    {},
    { schema: transformed },
  );
  const del: HttpResponse<{ value: number }> = await http.delete('/items', { schema: standard });
  const head: HttpResponse<void> = await http.head('/items');
  const headSchema: HttpResponse<string> = await http.head('/items', {
    schema: z.undefined().transform(() => 'empty'),
  });
  const request: HttpResponse<{ value: number }> = await http.request({
    method: 'GET',
    url: '/items',
    schema: descriptor,
  });
  const parser: HttpResponse<number> = await http.get('/items', { schema: { parse: () => 42 } });
  const asyncParser: HttpResponse<number> = await http.get('/items', {
    schema: { parse: async () => 42 },
  });
  const options = {
    schema: transformed,
    signal: new AbortController().signal,
  } satisfies RequestConfig<typeof transformed>;
  const withOptions: HttpResponse<{ value: number }> = await http.get('/items', options);
  const unchecked: HttpResponse<{ value: string }> = await http.get<{ value: string }>('/items');
  const uncheckedPost: HttpResponse<{ value: string }> = await http.post<{ value: string }>(
    '/items',
    {},
  );
  const unknown: HttpResponse<unknown> = await http.get('/items');
  // @ts-expect-error Schema output is a number, not the wire string.
  const wire: HttpResponse<{ value: string }> = await http.get('/items', { schema: transformed });
  // @ts-expect-error Caller-selected output cannot override schema inference.
  await http.get<{ value: string }>('/items', { schema: transformed });
  // @ts-expect-error A schema must be a supported runtime validator.
  await http.get('/items', { schema: {} });
  // @ts-expect-error Unknown responses must be narrowed or validated.
  const unsafe: HttpResponse<{ value: string }> = unknown;
  const schema: StandardSchemaV1<string, number> = {
    '~standard': { version: 1, vendor: 'test', validate: () => ({ value: 1 }) },
  };
  const structural: HttpResponse<number> = await http.get('/items', { schema });
  void [
    get,
    post,
    put,
    patch,
    del,
    head,
    headSchema,
    request,
    parser,
    asyncParser,
    withOptions,
    unchecked,
    uncheckedPost,
    unknown,
    wire,
    unsafe,
    structural,
  ];
}

export function checkHttpTransports(binding: { fetch: typeof globalThis.fetch }): void {
  const native: HttpFetch = globalThis.fetch;
  const transport: HttpTransport = binding;
  const nativeClient = new HttpService({ transport: native, headers: new Headers() });
  const bindingClient = new HttpService({ transport, headers: [['x-client', 'typed']] });
  // @ts-expect-error Transports return real Web responses.
  const invalidClient = new HttpService({ transport: async () => ({ status: 200 }) });
  void [nativeClient, bindingClient, invalidClient];
}
