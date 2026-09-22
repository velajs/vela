import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  APP_GUARD,
  APP_INTERCEPTOR,
  Controller,
  Get,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  VelaFactory,
  defineProvider,
} from '@velajs/vela';
import { createRpcClient, defineProcedure, type RpcClient } from '../index';
import { Rpc, RpcModule, RpcClientModule, rpcClientToken } from '../server';

const greet = defineProcedure({ name: 'greetings.hello', input: z.string(), output: z.string() });

@Injectable()
class Greetings {
  @Rpc(greet) hello(name: string) {
    return `Hello ${name}`;
  }
}

function client(app: Awaited<ReturnType<typeof VelaFactory.create>>) {
  return createRpcClient({
    url: 'https://worker/rpc',
    fetch: (request) => Promise.resolve(app.fetch(request)),
  });
}

describe('RPC module composition', () => {
  it('runs authorization and the global pipeline exactly once', async () => {
    let guards = 0,
      interceptors = 0,
      authorization = 0;
    @Module({
      imports: [
        RpcModule.forRoot({
          authorize: () => {
            authorization++;
            return true;
          },
        }),
      ],
      providers: [
        Greetings,
        defineProvider(APP_GUARD, {
          useValue: {
            canActivate() {
              guards++;
              return true;
            },
          },
        }),
        defineProvider(APP_INTERCEPTOR, {
          useValue: {
            intercept(_context, next) {
              interceptors++;
              return next.handle();
            },
          },
        }),
      ],
    })
    class Root {}
    const app = await VelaFactory.create(Root);
    expect(await client(app).call(greet, 'world')).toBe('Hello world');
    expect({ guards, interceptors, authorization }).toEqual({
      guards: 1,
      interceptors: 1,
      authorization: 1,
    });
    await app.close();
  });

  it('supports async server settings and injected named service-binding clients', async () => {
    @Module({
      providers: [Greetings],
      imports: [
        RpcModule.forRootAsync({ inject: [], useFactory: async () => ({ authorize: 'public' }) }),
      ],
    })
    class Server {}
    const server = await VelaFactory.create(Server);
    const ENV = new InjectionToken<{ SERVICE: { fetch(r: Request): Promise<Response> } }>(
      'bindings',
    );
    const binding = { fetch: (r: Request) => Promise.resolve(server.fetch(r)) };
    const rpc = RpcClientModule.registerAsync({
      name: 'greetings',
      binding: 'SERVICE',
      inject: [ENV],
      useFactory: async (env) => ({ url: 'https://worker/rpc', fetch: env.SERVICE }),
    });
    @Injectable()
    class Caller {
      constructor(@Inject(rpcClientToken('greetings')) readonly rpc: RpcClient) {}
      call() {
        return this.rpc.call(greet, 'worker');
      }
    }
    @Module({ imports: [rpc], providers: [Caller] })
    class Consumer {}
    const consumer = await VelaFactory.create(Consumer, {
      configureContainer(container) {
        container.register(defineProvider(ENV, { useValue: { SERVICE: binding } }));
        container.markGlobalToken(ENV);
      },
    });
    expect(await consumer.get(Caller).call()).toBe('Hello worker');
    expect(consumer.entrypoints.ofKind('rpc:client')[0]?.meta).toEqual({
      name: 'greetings',
      binding: 'SERVICE',
    });
    await Promise.all([consumer.close(), server.close()]);
  });

  it('rejects conflicting named clients and deduplicates reused imports', async () => {
    const shared = RpcClientModule.register({ name: 'shared', url: 'https://one/rpc' });
    @Module({ imports: [shared] })
    class Feature {}
    @Module({ imports: [shared, Feature] })
    class Good {}
    const good = await VelaFactory.create(Good);
    expect(good.entrypoints.ofKind('rpc:client')).toHaveLength(1);
    await good.close();
    @Module({
      imports: [shared, RpcClientModule.register({ name: 'shared', url: 'https://two/rpc' })],
    })
    class Bad {}
    await expect(VelaFactory.create(Bad)).rejects.toThrow('Duplicate RPC client');
  });

  it('rejects authorization, duplicate procedures and conflicting endpoint routes', async () => {
    @Module({ imports: [RpcModule.forRoot({ authorize: () => false })], providers: [Greetings] })
    class Denied {}
    const denied = await VelaFactory.create(Denied);
    await expect(client(denied).call(greet, 'worker')).rejects.toMatchObject({ status: 403 });
    await denied.close();
    @Injectable()
    class Duplicate {
      @Rpc(greet) hello(name: string) {
        return name;
      }
    }
    @Module({
      imports: [RpcModule.forRoot({ authorize: 'public' })],
      providers: [Greetings, Duplicate],
    })
    class Duplicates {}
    await expect(VelaFactory.create(Duplicates)).rejects.toThrow('Duplicate RPC');
    @Controller('/rpc')
    class Conflict {
      @Get() get() {
        return 'ok';
      }
    }
    const first = RpcModule.forRoot({ authorize: 'public', key: 'a' });
    const second = RpcModule.forRoot({ authorize: 'public', key: 'b' });
    @Module({ imports: [first, second], controllers: [Conflict] })
    class Conflicts {}
    await expect(VelaFactory.create(Conflicts)).rejects.toThrow('conflicts');
  });
});
