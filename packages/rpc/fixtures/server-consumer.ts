/* eslint-disable typescript/no-extraneous-class -- Vela modules are metadata-only classes. */
/* eslint-disable no-console -- Executable verification fixture. */
import { Injectable, Module, Scope, VelaFactory } from '@velajs/vela';
import { createRpcClient, defineProcedure, RpcError } from '@velajs/rpc';
import type { ProcedureInput } from '@velajs/rpc';
import { Rpc, rpcAdapter } from '@velajs/rpc/server';
import { z } from 'zod';

let inputs = 0;
let outputs = 0;
let disposed = 0;
const contract = defineProcedure({
  name: 'packed.double',
  input: z.string().transform(async (value) => {
    inputs++;
    return Number(value);
  }),
  output: z.number().transform(async (value) => {
    outputs++;
    return { value };
  }),
});
@Injectable({ scope: Scope.REQUEST })
class Handler {
  readonly #factor = 2;
  @Rpc(contract)
  call(value: ProcedureInput<typeof contract>) {
    return value * this.#factor;
  }
  dispose() {
    disposed++;
  }
}
@Module({ providers: [Handler] })
class Application {}

const app = await VelaFactory.create(Application, {
  adapters: [
    rpcAdapter({
      authorize: (context) => context.getRequest().headers.get('authorization') === 'fixture',
    }),
  ],
  diagnostics: 'silent',
});
try {
  const client = createRpcClient({
    url: 'https://packed.test/rpc',
    fetch: async (request) => app.fetch(request),
  });
  const response = await client.call(contract, '21', { headers: { authorization: 'fixture' } });
  const value: number = response.value;
  if (value !== 42 || inputs !== 1 || outputs !== 1)
    throw new Error('Packed schema transforms or private receiver failed');
  const failure: unknown = await client.call(contract, '21').catch((error: unknown) => error);
  if (!(failure instanceof RpcError) || failure.status !== 403)
    throw new Error('Packed guard failed');
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (disposed !== 1) throw new Error('Packed request disposal failed');
  console.log('Packed RPC server/client roundtrip, guards, transforms and disposal passed');
} finally {
  await app.dispose();
}
