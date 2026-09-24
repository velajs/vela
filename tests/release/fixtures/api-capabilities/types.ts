import { z } from 'zod';
import { Body, Post } from '@velajs/vela';
import { defineRoute, type ContractApp } from '@velajs/vela/contract';
import {
  ResponseCacheService,
  type ResponseCacheOptions,
  type CacheInvalidationResult,
} from '@velajs/vela/cache';
import {
  hc,
  withFormEncoding,
  type InferRequestType,
  type InferResponseType,
} from '@velajs/client/http';
import { executeAtomicBatch, requireAtomicBatch, type AtomicResults } from '@velajs/crud';
import { drizzleAdapter } from '@velajs/crud-drizzle';
import { drizzle } from 'drizzle-orm/libsql';
import { text, sqliteTable } from 'drizzle-orm/sqlite-core';
import { type AppType, formEncodings } from './generated-api';

const client = hc<AppType>('https://fixture.test', { fetch: withFormEncoding(formEncodings) });
type Upload = InferRequestType<(typeof client.records)[':id']['attachments']['$post']>;
const upload: Upload = {
  param: { id: 'one' },
  form: { label: 'Document', labels: ['first'], file: new File(['hello'], 'document.txt') },
};
// @ts-expect-error Binary fields must not become arbitrary strings in generated declarations.
const wrongFile: Upload['form']['file'] = 'document.txt';
// @ts-expect-error Repeated fields retain array types.
const wrongLabels: Upload['form']['labels'] = 'first';
type Uploaded = InferResponseType<(typeof client.records)[':id']['attachments']['$post'], 201>;
const size = (value: Uploaded): number => value.size;

const Counted = z.object({ count: z.string().transform(Number) });
const Count = z.object({ count: z.number() });
class Forms {
  @Post('/count', { response: Count, body: { form: {} } })
  count(@Body(Counted) form: z.output<typeof Counted>) {
    const count: number = form.count;
    return { count };
  }

  // @ts-expect-error Handler output must agree with the route's response schema.
  @Post('/wrong', { response: Count })
  wrong() {
    return { count: 'wrong' };
  }
}
const counted = defineRoute({
  method: 'POST',
  path: '/count',
  body: Counted,
  form: {},
  response: Count,
});
const contractClient = hc<ContractApp<[typeof counted]>>('https://fixture.test');
const counting: Promise<number> = contractClient.count
  .$post({ form: { count: '1' } })
  .then(async (response) => (await response.json()).count);
// @ts-expect-error Form values are strings on the wire.
void contractClient.count.$post({ form: { count: 1 } });

declare const options: ResponseCacheOptions;
const cache = new ResponseCacheService(options).scope({
  visibility: 'private',
  partition: 'verified-subject',
});
const parsed: Promise<{ count: number } | undefined> = cache.getParsed(
  'summary',
  z.object({ count: z.number() }).parse,
);
const invalidated: Promise<CacheInvalidationResult> = cache.invalidateTags(['records']);

declare const db: ReturnType<typeof drizzle>;
const records = sqliteTable('records', { id: text().primaryKey(), label: text().notNull() });
const schema = z.object({ id: z.string(), label: z.string() });
const adapter = drizzleAdapter({ db, table: records, parseRow: schema.parse });
const batch = requireAtomicBatch(adapter);
const commands = [
  batch.create({ id: 'one', label: 'First' }),
  batch.update({ field: 'id', value: 'one' }, { label: 'Next' }),
] as const;
const pending: Promise<AtomicResults<typeof commands>> = executeAtomicBatch(adapter, commands);
void pending.then(([created, updated]) => {
  const label: string = created.label;
  const next: string | undefined = updated?.label;
  // @ts-expect-error The create result is the decoded row, not caller-selected data.
  const unknownField: number = created.missing;
  return [label, next, unknownField];
});
void [upload, wrongFile, wrongLabels, size, parsed, invalidated, Forms, counting];
