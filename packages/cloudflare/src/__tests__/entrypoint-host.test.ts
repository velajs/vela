import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  APP_EXCEPTION_HANDLER,
  Controller,
  Get,
  Inject,
  InjectionToken,
  Injectable,
  Module,
  NotFoundException,
  ParseIntPipe,
  Scope,
  UseGuards,
  UsePipes,
  defineProvider,
  type CanActivate,
  type ErrorReportContext,
  type VelaEnv,
} from '@velajs/vela';
import type { EntrypointExecutionContext, RuntimeAdapter } from '@velajs/vela/module-kit';
import { cloudflareApplication } from '../cloudflare-factory';
import {
  CLOUDFLARE_ENTRYPOINT,
  CLOUDFLARE_WORKER,
  EntrypointError,
  defineCloudflareApp,
  isEntrypointError,
  type CloudflareApp,
} from '../index';
import { ENTRYPOINT_PROPS, VelaEntrypoint, type EntrypointRpcMethod } from '../entrypoints';
import { entrypointHostMembers } from '../entrypoint/vela-entrypoint';

const REPORTS = new InjectionToken<{ error: unknown; context: ErrorReportContext }[]>('reports');

const reporting: RuntimeAdapter = {
  name: 'reports',
  configureContainer(container) {
    const reports: { error: unknown; context: ErrorReportContext }[] = [];
    container.register(defineProvider(REPORTS, { useValue: reports }));
    container.markGlobalToken(REPORTS);
    container.register(
      defineProvider(APP_EXCEPTION_HANDLER, {
        useValue: { report: (error: unknown, context) => void reports.push({ error, context }) },
      }),
    );
  },
};

function isPlatformContext(value: object): value is ExecutionContext {
  return 'waitUntil' in value && 'props' in value;
}

/** The platform's ExecutionContext of a service binding call, carrying the caller's props. */
function callContext(props: unknown = {}): ExecutionContext {
  const ctx = { waitUntil() {}, passThroughOnException() {}, props, exports: {} };
  if (!isPlatformContext(ctx)) throw new Error('Not an execution context.');
  return ctx;
}

const httpContext = { waitUntil() {}, passThroughOnException() {}, props: {} };

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a rejection');
}

async function rpcFailure(promise: Promise<unknown>): Promise<EntrypointError> {
  const error = await rejection(promise);
  if (!(error instanceof EntrypointError)) throw new Error(`Unexpected rejection: ${error}`);
  return error;
}

async function reportsOf(
  app: CloudflareApp,
  env: VelaEnv,
): Promise<{ error: unknown; context: ErrorReportContext }[]> {
  return (await cloudflareApplication(app, env)).get(REPORTS);
}

describe('VelaEntrypoint host members', () => {
  it('rejects rpc names the entrypoint, its stubs or the platform own', () => {
    for (const name of [
      'ctx',
      'env',
      'fetch',
      'connect',
      'dup',
      'then',
      'email',
      'queue',
      'scheduled',
      'tail',
      'tailStream',
      'test',
      'trace',
    ]) {
      class Clashing {}
      if (name !== 'then') {
        Object.defineProperty(Clashing.prototype, name, { value: () => undefined });
      }
      expect(() => entrypointHostMembers(Clashing, [name])).toThrow(
        `'${name}' is reserved by the service entrypoint class or its stubs`,
      );
    }
  });
});

describe('VelaEntrypoint', () => {
  it('serves the listed host methods in the Worker application, with a scope per call', async () => {
    let calls = 0;
    @Injectable()
    class Ledger {
      readonly charges: string[] = [];
    }
    @Injectable({ scope: Scope.REQUEST })
    class CallTrace {
      readonly id = ++calls;
    }
    @Injectable()
    class BillingHost {
      constructor(
        private readonly ledger: Ledger,
        @Inject(CallTrace) private readonly trace: CallTrace,
        @Inject(ENTRYPOINT_PROPS) private readonly props: unknown,
      ) {}
      async charge(customer: string, cents: number): Promise<{ call: number; props: unknown }> {
        this.ledger.charges.push(`${customer}:${cents}`);
        return { call: this.trace.id, props: this.props };
      }
      audit(): string[] {
        return this.ledger.charges;
      }
      private refundAll(): void {
        this.ledger.charges.length = 0;
      }
    }
    @Controller('/charges')
    class ChargesController {
      constructor(private readonly ledger: Ledger) {}
      @Get()
      list(): string[] {
        return this.ledger.charges;
      }
    }
    @Module({ controllers: [ChargesController], providers: [Ledger, CallTrace] })
    class AppModule {}

    const app = defineCloudflareApp(AppModule);
    class Billing extends VelaEntrypoint(app, BillingHost, { rpc: ['charge'] }) {}
    expectTypeOf<EntrypointRpcMethod<BillingHost>>().toEqualTypeOf<'charge' | 'audit'>();

    const env = {};
    const billing = new Billing(callContext({ tenant: 'acme' }), env);
    expectTypeOf(billing.charge).parameters.toEqualTypeOf<[customer: string, cents: number]>();
    expect(await billing.charge('c1', 500)).toEqual({ call: 1, props: { tenant: 'acme' } });
    const other = new Billing(callContext(), env);
    expect(await other.charge('c2', 700)).toEqual({ call: 2, props: {} });

    // The Worker's fetch handler shares the application and its singletons.
    const response = await app.worker.fetch(
      new Request('https://worker.test/charges'),
      env,
      httpContext,
    );
    expect(await response.json()).toEqual(['c1:500', 'c2:700']);

    // Unlisted methods are no RPC methods: the class does not define them.
    expect(Reflect.get(billing, 'audit')).toBeUndefined();
    expect(Reflect.get(billing, 'refundAll')).toBeUndefined();

    // Another environment identity is another application.
    const isolated = {};
    expect(await new Billing(callContext(), isolated).charge('c3', 1)).toMatchObject({ call: 3 });
    const isolatedResponse = await app.worker.fetch(
      new Request('https://worker.test/charges'),
      isolated,
      httpContext,
    );
    expect(await isolatedResponse.json()).toEqual(['c3:1']);
  });

  it('runs scoped guards and pipes, and redacts failures across RPC', async () => {
    const seen: EntrypointExecutionContext[] = [];
    @Injectable()
    class TenantGuard implements CanActivate {
      constructor(@Inject(ENTRYPOINT_PROPS) private readonly props: unknown) {}
      canActivate(context: EntrypointExecutionContext): boolean {
        seen.push(context);
        return (
          typeof this.props === 'object' &&
          this.props !== null &&
          Reflect.get(this.props, 'tenant') === 'acme'
        );
      }
    }
    @UseGuards(TenantGuard)
    @Injectable()
    class AccountsHost {
      @UsePipes(ParseIntPipe)
      double(value: number): number {
        return value * 2;
      }
      missing(): never {
        throw new NotFoundException('No such account');
      }
      leak(): never {
        throw new Error('connection string postgres://secret@db');
      }
    }
    @Module({ providers: [TenantGuard] })
    class AppModule {}
    const app = defineCloudflareApp(AppModule, { adapters: [reporting] });
    class Accounts extends VelaEntrypoint(app, AccountsHost, {
      rpc: ['double', 'missing', 'leak'],
    }) {}
    const env = {};
    const accounts = new Accounts(callContext({ tenant: 'acme' }), env);

    expect(await accounts.double(Number('21'))).toBe(42);
    expect(await Reflect.apply(accounts.double, accounts, ['21'])).toBe(42);
    const [context] = seen;
    expect(context?.getType()).toBe('rpc');
    expect(context?.getClass()).toBe(AccountsHost);
    expect(context?.getHandlerName()).toBe('double');

    const denied = await rpcFailure(new Accounts(callContext({ tenant: 'other' }), env).double(1));
    expect(denied).toMatchObject({ status: 403, code: 'forbidden', message: 'Forbidden' });

    expect(await rpcFailure(accounts.missing())).toMatchObject({
      status: 404,
      code: 'not_found',
      message: 'No such account',
    });
    const leaked = await rpcFailure(accounts.leak());
    expect(isEntrypointError(leaked)).toBe(true);
    expect({ ...leaked }).toEqual({ name: 'EntrypointError', status: 500, code: 'internal' });
    expect(leaked.message).toBe('Internal Server Error');
    expect(
      JSON.stringify(Object.getOwnPropertyNames(leaked).map((key) => Reflect.get(leaked, key))),
    ).not.toContain('secret');

    const reports = await reportsOf(app, env);
    expect(reports.map(({ context }) => context)).toMatchObject([
      { edge: 'rpc', source: 'AccountsHost.double', kind: 'rpc' },
      { edge: 'rpc', source: 'AccountsHost.missing', kind: 'rpc' },
      { edge: 'rpc', source: 'AccountsHost.leak', kind: 'rpc' },
    ]);
    expect(String(reports[2]?.error)).toContain('postgres://secret@db');
  });

  it('rejects calls with a redacted error when the application fails to start', async () => {
    @Injectable()
    class BrokenStart {
      onModuleInit(): void {
        throw new Error('secret startup detail');
      }
    }
    @Injectable()
    class PingHost {
      ping(): string {
        return 'pong';
      }
    }
    @Module({ providers: [BrokenStart] })
    class AppModule {}
    const app = defineCloudflareApp(AppModule);
    class Ping extends VelaEntrypoint(app, PingHost, { rpc: ['ping'] }) {}
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      const failure = await rpcFailure(new Ping(callContext(), {}).ping());
      expect({ ...failure, message: failure.message }).toEqual({
        name: 'EntrypointError',
        status: 500,
        code: 'internal',
        message: 'Internal Server Error',
      });
    } finally {
      console.error = original;
    }
    expect(String(errors[0])).toContain('PingHost');
  });

  it('describes its classes for tools', () => {
    @Injectable()
    class SearchHost {
      query(text: string): string[] {
        return [text];
      }
    }
    @Module({})
    class AppModule {}
    const app = defineCloudflareApp(AppModule);
    const Search = VelaEntrypoint(app, SearchHost, { rpc: ['query'] });
    class ExportedSearch extends Search {}
    expect(Reflect.get(ExportedSearch, CLOUDFLARE_ENTRYPOINT)).toEqual({
      rootModule: AppModule,
      host: SearchHost,
      methods: ['query'],
      entrypoint: Search,
    });
    expect(Search.name).toBe('SearchHostEntrypoint');
    expect(app.worker[CLOUDFLARE_WORKER].entrypoints).toEqual([
      Reflect.get(Search, CLOUDFLARE_ENTRYPOINT),
    ]);
    class Thenable {
      query(): void {}
      then(): void {}
    }
    expect(() => VelaEntrypoint(app, Thenable, { rpc: ['query'] })).toThrow(
      'Thenable defines then()',
    );
    // @ts-expect-error a service entrypoint runs in the Worker application of an app definition
    expect(() => VelaEntrypoint(AppModule, SearchHost)).toThrow('defineCloudflareApp');
  });
});
