import { z } from 'zod';
import { defineEndpoint } from '@velajs/vela/openapi';
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

const endpoint = defineEndpoint({
  body: { contentType: 'application/x-www-form-urlencoded' },
  input: z.object({ form: z.object({ count: z.string().transform(Number) }) }),
  output: z.object({ count: z.number() }),
});
endpoint.bind((input) => {
  const count: number = input.form.count;
  return { count };
});
// @ts-expect-error Handler output must agree with the endpoint's response schema.
endpoint.bind(() => ({ count: 'wrong' }));

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
void [upload, wrongFile, wrongLabels, size, parsed, invalidated];
