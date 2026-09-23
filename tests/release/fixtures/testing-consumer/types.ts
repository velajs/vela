import { InjectionToken, defineProvider, REQUEST_CONTEXT } from '@velajs/vela';
import type { StandardSchemaV1 } from '@velajs/vela/validation';
import { Test, createTestHttpClient, type TestingModule } from '@velajs/testing';

interface Database {
  read(id: string): Promise<string>;
}
const DATABASE = new InjectionToken<Database>('database');
const database = { read: async (id: string) => id } satisfies Database;
const builder = Test.createTestingModule({
  providers: [defineProvider(DATABASE, { useValue: database })],
});
builder.overrideProvider(DATABASE).useFactory({
  inject: [REQUEST_CONTEXT],
  factory: (context) => ({ read: async (id) => `${context.id}:${id}` }),
});
// @ts-expect-error Missing port method must be rejected.
builder.overrideProvider(DATABASE).useValue({});
// @ts-expect-error Factories cannot change the port's return contract.
builder.overrideProvider(DATABASE).useFactory({ inject: [], factory: () => ({ read: () => 1 }) });

async function consumer(module: TestingModule) {
  const resolvedDatabase: Database = module.get(DATABASE);
  const result: string = await resolvedDatabase.read('key');
  const response = await createTestHttpClient({
    baseUrl: 'https://worker.test/',
    fetch: (request) => module.fetch(request),
  })
    .get('/')
    .send();
  const unknown: unknown = await response.json();
  const validated: number = await response.json({
    parse: (value) => {
      if (typeof value !== 'number') throw new TypeError('Expected number');
      return value;
    },
  });
  // @ts-expect-error Unvalidated response data cannot invent a result type.
  await response.json<Date>();
  void [result, unknown, validated];
}
void consumer;

async function transformed(module: TestingModule, schema: StandardSchemaV1<string, number>) {
  const response = await module.http.get('/').send();
  const value: number = await response.json(schema);
  // @ts-expect-error A Standard Schema output cannot be changed to its wire input.
  const invalid: string = await response.json(schema);
  void [value, invalid];
}
void transformed;
