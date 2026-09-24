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
  type ExecutionContext,
  type MiddlewareConsumer,
  type NestMiddleware,
  type NestModule,
} from '@velajs/vela';
import { getTrustedRequestIdentity, setTrustedRequestIdentity } from '@velajs/vela/module-kit';
import { createRpcClient, defineProcedure, RpcError, type RpcClient } from '../index';
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

  it('runs global guards in phase order, including factory-provided ones', async () => {
    const trace: string[] = [];
    @Injectable()
    class Authorize {
      static readonly phase = 'authorize';
      canActivate() {
        trace.push('authorize');
        return true;
      }
    }
    class FactoryAuthenticate {
      static readonly phase = 'authenticate';
      canActivate() {
        trace.push('authenticate');
        return true;
      }
    }
    @Module({
      imports: [RpcModule.forRoot({ authorize: 'public' })],
      providers: [
        Greetings,
        Authorize,
        defineProvider(APP_GUARD, { useExisting: Authorize }),
        defineProvider(APP_GUARD, { useFactory: () => new FactoryAuthenticate() }),
      ],
    })
    class Root {}
    const app = await VelaFactory.create(Root);
    expect(await client(app).call(greet, 'world')).toBe('Hello world');
    expect(trace).toEqual(['authenticate', 'authorize']);
    await app.close();
  });

  it('runs the authorize policy after global authentication and tenant guards', async () => {
    const trace: string[] = [];
    const phase = (name: 'authenticate' | 'tenant' | 'authorize' | 'feature') => ({
      phase: name,
      canActivate(context: ExecutionContext) {
        trace.push(name);
        const request = context.getRequest();
        if (name === 'authenticate' && request.headers.get('x-user') === 'alice') {
          setTrustedRequestIdentity(request, {
            principal: { issuer: 'tests', subject: 'alice', principalType: 'user' },
          });
        }
        return true;
      },
    });
    @Module({
      imports: [
        RpcModule.forRoot({
          // An identity-based policy sees the identity global authentication published.
          authorize: (context) => {
            trace.push('rpc');
            return getTrustedRequestIdentity(context.getRequest())?.principal.subject === 'alice';
          },
        }),
      ],
      providers: [
        Greetings,
        ...(['feature', 'authorize', 'tenant', 'authenticate'] as const).map((name) =>
          defineProvider(APP_GUARD, { useValue: phase(name) }),
        ),
      ],
    })
    class Root {}
    const app = await VelaFactory.create(Root);
    const alice = createRpcClient({
      url: 'https://worker/rpc',
      headers: { 'x-user': 'alice' },
      fetch: (request) => Promise.resolve(app.fetch(request)),
    });
    expect(await alice.call(greet, 'world')).toBe('Hello world');
    expect(trace).toEqual(['authenticate', 'tenant', 'rpc', 'authorize', 'feature']);
    trace.length = 0;
    const denied = await client(app)
      .call(greet, 'world')
      .catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(RpcError);
    expect(denied).toMatchObject({ status: 403 });
    expect(trace).toEqual(['authenticate', 'tenant', 'rpc']);
    await app.close();
  });

  it('supports async server settings and injected named service-binding clients', async () => {
    @Module({
      providers: [Greetings],
      imports: [RpcModule.forRootAsync({ useFactory: async () => ({ authorize: 'public' }) })],
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

  it('registers a client whose options factory takes no dependencies', async () => {
    @Module({ providers: [Greetings], imports: [RpcModule.forRoot({ authorize: 'public' })] })
    class Server {}
    const server = await VelaFactory.create(Server);
    const rpc = RpcClientModule.registerAsync({
      name: 'static-greetings',
      useFactory: () => ({
        url: 'https://worker/rpc',
        fetch: (request: Request) => Promise.resolve(server.fetch(request)),
      }),
    });
    @Module({ imports: [rpc] })
    class Consumer {}
    const consumer = await VelaFactory.create(Consumer);
    const token = rpcClientToken('static-greetings');
    expect(await consumer.get(token).call(greet, 'factory')).toBe('Hello factory');
    const missingInject = () =>
      // @ts-expect-error A factory with parameters names the tokens that supply them.
      RpcClientModule.registerAsync({ name: 'missing', useFactory: (url: string) => ({ url }) });
    void missingInject;
    await Promise.all([consumer.close(), server.close()]);
  });

  it.each([undefined, '/api'])(
    'runs consumer middleware for the endpoint as an absolute target under prefix %s',
    async (globalPrefix) => {
      const seen: string[] = [];
      @Injectable()
      class Audit implements NestMiddleware {
        use: NestMiddleware['use'] = async (c, next) => {
          seen.push(`${c.req.method} ${c.req.path}`);
          await next();
        };
      }
      @Module({
        imports: [RpcModule.forRoot({ authorize: 'public' })],
        providers: [Greetings, Audit],
      })
      class Root implements NestModule {
        configure(consumer: MiddlewareConsumer) {
          consumer.apply(Audit).forRoutes({ path: '/rpc', absolute: true });
        }
      }
      const app = await VelaFactory.create(Root, globalPrefix ? { globalPrefix } : {});
      expect(await client(app).call(greet, 'world')).toBe('Hello world');
      expect(seen).toEqual(['POST /rpc']);
      await app.close();
    },
  );

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
