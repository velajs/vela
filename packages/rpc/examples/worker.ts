/* eslint-disable typescript/no-extraneous-class -- Vela modules are metadata-only classes. */
import { Injectable, Module, VelaFactory } from '@velajs/vela';
import type { VelaApplication } from '@velajs/vela';
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

// This example has no environment bindings. Apps that use env should compose
// cloudflareAdapter and cache construction per environment identity instead.
let pending: Promise<VelaApplication> | undefined;
export default {
  async fetch(request: Request): Promise<Response> {
    pending ??= VelaFactory.create(Application, {
      adapters: [rpcAdapter({ path: '/rpc', authorize: 'public' })],
    }).catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return (await pending).fetch(request);
  },
};
