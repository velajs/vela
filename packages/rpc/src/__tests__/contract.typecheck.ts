import { z } from 'zod';
import { InjectionToken } from '@velajs/vela';
import { defineProcedure, createRpcClient } from '../index';
import type {
  ProcedureInput,
  ProcedureOutput,
  ProcedureResult,
  ProcedureWireInput,
} from '../index';
import { Rpc, RpcClientModule, type RpcClientAsyncOptions } from '../server';

const RPC_URL = new InjectionToken<string>('rpc:typecheck:url');
const globalClientOptions = {
  name: 'typed-client',
  isGlobal: true,
  inject: [RPC_URL],
  useFactory: (url) => ({ url }),
} satisfies RpcClientAsyncOptions<readonly [typeof RPC_URL]>;
RpcClientModule.registerAsync(globalClientOptions);

const procedure = defineProcedure({
  name: 'math.parse',
  input: z.string().transform(Number),
  output: z.number().transform((n) => ({ doubled: n * 2 })),
});
const wire: ProcedureWireInput<typeof procedure> = '4';
const parsed: ProcedureInput<typeof procedure> = 4;
const handlerResult: ProcedureResult<typeof procedure> = 4;
const output: ProcedureOutput<typeof procedure> = { doubled: 8 };
void [wire, parsed, handlerResult, output];
// @ts-expect-error Wire input is a string, not the transformed number.
const wrongInput: ProcedureWireInput<typeof procedure> = 4;
// @ts-expect-error Handler input is the transformed number.
const wrongParsed: ProcedureInput<typeof procedure> = '4';
// @ts-expect-error Output schema input is the handler's return type.
const wrongResult: ProcedureResult<typeof procedure> = { doubled: 8 };
// @ts-expect-error Client sees transformed schema output.
const wrongOutput: ProcedureOutput<typeof procedure> = 8;
void [wrongInput, wrongParsed, wrongResult, wrongOutput];
// @ts-expect-error Names require a namespace.
defineProcedure({ name: 'get', input: z.string(), output: z.string() });
class Valid {
  @Rpc(procedure)
  parse(value: number): number {
    return value;
  }
}
class Invalid {
  // @ts-expect-error Decorator may not infer wider handler input.
  @Rpc(procedure)
  badInput(value: string): number {
    return value.length;
  }
  // @ts-expect-error Decorator enforces output schema input.
  @Rpc(procedure)
  badOutput(value: number): string {
    return String(value);
  }
}
void [Valid, Invalid];
async function checkClient() {
  const client = createRpcClient({ url: 'https://rpc.test/rpc' });
  const result = await client.call(procedure, '4');
  const value: number = result.doubled;
  // @ts-expect-error Client cannot pass parsed input in place of wire input.
  await client.call(procedure, 4);
  // @ts-expect-error Decoder must match the schema-derived result and cannot widen it.
  await client.call(procedure, '4', { decode: () => 'wrong' });
  // @ts-expect-error Output has no secret property.
  void result.secret;
  return value;
}
void checkClient;
