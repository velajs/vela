/* eslint-disable typescript/no-extraneous-class -- Vela modules are metadata-only classes. */
import { Injectable, Module } from '@velajs/vela';
import { createCloudflareWorker } from '@velajs/cloudflare';
import type { ProcedureInput } from '../src/index';
import { Rpc, rpcAdapter } from '../src/server';
import { greet } from './contracts';

@Injectable()
class Greetings {
  readonly #prefix = 'Hello';
  @Rpc(greet)
  hello(input: ProcedureInput<typeof greet>) {
    return { message: `${this.#prefix}, ${input.name}!` };
  }
}
@Module({ providers: [Greetings] })
class Application {}

// One application per Worker environment; the RPC adapter composes with the
// Cloudflare adapter, which seeds that environment as ENV.
export default createCloudflareWorker(Application, {
  adapters: [rpcAdapter({ path: '/rpc', authorize: 'public' })],
});
