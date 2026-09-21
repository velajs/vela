import {
  InjectionToken,
  defineProvider,
  forwardRef,
  type Token,
  type StandardSchemaV1,
} from '@velajs/vela';
import { Test } from '../test.js';
import type { TestingModule } from '../testing-module.js';
import type { TestResponse } from '../http/test-response.js';

class Counter {
  count = 1;
}

class WrongCounter {
  count = 'invalid';
}

const COUNT = new InjectionToken<number>('count');
const PREFIX = new InjectionToken<string>('prefix');
const LABEL = new InjectionToken<string>('label');

// Included by the regular package typecheck, without executing declarations.
function providerContracts(module: TestingModule): void {
  const counter: Counter = module.get(Counter);
  const resolvedCount: number = module.get(COUNT);
  const untyped: unknown = module.get('untyped');
  void [counter, resolvedCount, untyped];

  // @ts-expect-error Typed tokens fix the resolved value type.
  const invented: Date = module.get(COUNT);
  // @ts-expect-error get's type argument describes the actual token, not a requested result.
  module.get<Date>(COUNT);

  const builder = Test.createTestingModule({ providers: [defineProvider(COUNT, { useValue: 1 })] });
  builder.overrideProvider(COUNT).useValue(2);
  builder.overrideProvider(Counter).useClass(Counter);
  builder.overrideProvider(LABEL).useFactory({
    inject: [PREFIX, COUNT],
    factory: (prefix, count) => prefix.toUpperCase() + count.toFixed(),
  });
  builder.overrideProvider(LABEL).useFactory({ inject: [], factory: async () => 'async' });
  builder.overrideProvider(LABEL).useFactory({
    inject: [forwardRef(() => COUNT)],
    factory: (count) => count.toFixed(),
  });

  // @ts-expect-error Widening a token identity cannot authorize an unrelated override.
  builder.overrideProvider<Token>(COUNT).useValue('bad');
  // @ts-expect-error Invariant injection tokens cannot be widened explicitly.
  builder.overrideProvider<InjectionToken<unknown>>(COUNT).useValue('bad');
  const erased: Token = COUNT;
  // @ts-expect-error An erased registry identity no longer carries permission to author values.
  builder.overrideProvider(erased).useValue('bad');

  // @ts-expect-error Token values cannot be replaced by unrelated values.
  builder.overrideProvider(COUNT).useValue('wrong');
  // @ts-expect-error Class overrides must produce the token's instance contract.
  builder.overrideProvider(Counter).useClass(WrongCounter);
  // @ts-expect-error Factories must return the token's value type.
  builder.overrideProvider(COUNT).useFactory({ inject: [], factory: () => 'wrong' });
  const labelOverride = builder.overrideProvider(LABEL);
  // @ts-expect-error The declared dependency tuple must be supplied at runtime.
  labelOverride.useFactory<readonly [typeof COUNT]>({ factory: (count) => count.toFixed() });
  builder.overrideProvider(LABEL).useFactory({
    inject: [COUNT],
    // @ts-expect-error Factory dependencies are inferred from their supplied tokens.
    factory: (count: string) => count.toUpperCase(),
  });
  builder.overrideProvider(LABEL).useFactory({
    inject: [COUNT],
    // @ts-expect-error A factory cannot request extra unsupplied dependencies.
    factory: (count, missing: string) => `${count}${missing}`,
  });
  void invented;
}

async function responseContracts(response: TestResponse): Promise<void> {
  const unknownBody: unknown = await response.json();
  // @ts-expect-error Raw response JSON cannot invent a Date result.
  const rawDate: Date = await response.json();
  // @ts-expect-error A result type requires a parser as runtime evidence.
  await response.json<Date>();

  const count: number = await response.json({
    parse(value: unknown) {
      if (typeof value !== 'number') throw new TypeError('Expected number');
      return value;
    },
  });
  // @ts-expect-error The supplied parser produces a number, not a Date.
  const parsedDate: Date = await response.json({ parse: (_: unknown) => 1 });
  void [unknownBody, rawDate, count, parsedDate];
}

void [providerContracts, responseContracts];

interface DatabasePort {
  read(id: string): Promise<string>;
}
class Database implements DatabasePort {
  #prefix = 'record';
  async read(id: string): Promise<string> {
    return `${this.#prefix}:${id}`;
  }
}
const DATABASE = new InjectionToken<DatabasePort>('database-port');
const databaseFake = { read: async (id: string) => id } satisfies DatabasePort;
const portBuilder = Test.createTestingModule({
  providers: [defineProvider(DATABASE, { useClass: Database })],
});
portBuilder.overrideProvider(DATABASE).useValue(databaseFake);
portBuilder
  .overrideProvider(DATABASE)
  .useFactory({ inject: [], factory: async () => databaseFake });
// @ts-expect-error A fake must implement the whole injected port.
portBuilder.overrideProvider(DATABASE).useValue({});
// @ts-expect-error Return values must honor the port, including asynchronous results.
portBuilder.overrideProvider(DATABASE).useValue({ read: () => 'unvalidated' });

async function standardResponseContracts(
  response: TestResponse,
  schema: StandardSchemaV1<string, number>,
) {
  const transformed: number = await response.json(schema);
  // @ts-expect-error A transformed response is the schema output, not its wire input.
  const wire: string = await response.json(schema);
  const asyncLegacy: number = await response.json({ parse: () => 0, parseAsync: async () => 42 });
  const explicitLegacy: number = await response.json<number>({ parse: () => 42 });
  void [transformed, wire, asyncLegacy, explicitLegacy];
}
void standardResponseContracts;
