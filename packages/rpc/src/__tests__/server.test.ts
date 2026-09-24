/* eslint-disable typescript/no-extraneous-class -- Vela modules are metadata-only classes. */
/* eslint-disable no-await-in-loop -- Each isolated application is disposed before the next fixture. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  APP_GUARD,
  APP_EXCEPTION_HANDLER,
  defineProvider,
  EXECUTION_LIFETIME,
  HttpException,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  REQUEST_CONTEXT,
  Scope,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
  VelaFactory,
} from '@velajs/vela';
import { ValidationPipe } from '@velajs/vela/validation';
import type {
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
  ExecutionLifetime,
  HttpErrorResponse,
  NestInterceptor,
  RequestContext,
  VelaApplication,
} from '@velajs/vela';
import { createRpcClient, defineProcedure } from '../index';
import { Rpc, rpcAdapter } from '../server';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function client(app: VelaApplication) {
  return createRpcClient({
    url: 'https://rpc.test/rpc',
    fetch: (r) => Promise.resolve(app.fetch(r)),
  });
}
function request(procedure: string, input: unknown) {
  return new Request('https://rpc.test/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, id: 'call', procedure, input }),
  });
}

describe('Vela RPC adapter', () => {
  it('awaits async pipes in order without speculative transform retries', async () => {
    let transforms = 0;
    const contract = defineProcedure({ name: 'pipe.async', input: z.number(), output: z.number() });
    const parser = new ValidationPipe(
      z.string().transform(async (value) => {
        transforms++;
        return Number(value);
      }),
    );
    @Injectable()
    class Handler {
      @Rpc(contract)
      @UsePipes(parser, {
        transform(value: unknown) {
          return Number(value) + 1;
        },
      })
      call(value: number) {
        return value;
      }
    }
    @Module({ providers: [Handler] })
    class App {}
    const app = await VelaFactory.create(App, {
      adapters: [rpcAdapter({ authorize: 'public' })],
      diagnostics: 'silent',
    });
    try {
      const response = await app.fetch(request(contract.name, '41'));
      expect(await response.json()).toMatchObject({ ok: true, result: 42 });
      expect(transforms).toBe(1);
    } finally {
      await app.dispose();
    }
  });
  it('retains the HTTP scope through deferred work after the RPC response is consumed', async () => {
    const release = Promise.withResolvers<void>();
    const done = Promise.withResolvers<void>();
    let disposed = false;
    let lifetime: ExecutionLifetime | undefined;
    const contract = defineProcedure({
      name: 'lifetime.read',
      input: z.null(),
      output: z.string(),
    });
    @Injectable({ scope: Scope.REQUEST })
    class Handler {
      constructor(@Inject(EXECUTION_LIFETIME) readonly execution: ExecutionLifetime) {}
      @Rpc(contract) call(_: null) {
        lifetime = this.execution;
        this.execution.defer(async () => {
          await release.promise;
        });
        return 'done';
      }
      dispose() {
        disposed = true;
        done.resolve();
      }
    }
    @Module({ providers: [Handler] })
    class App {}
    const app = await VelaFactory.create(App, {
      adapters: [rpcAdapter({ authorize: 'public' })],
      diagnostics: 'silent',
    });
    try {
      const requestSignal = new AbortController();
      expect(await client(app).call(contract, null, { signal: requestSignal.signal })).toBe('done');
      expect(lifetime?.active).toBe(true);
      expect(disposed).toBe(false);
      release.resolve();
      await done.promise;
      expect(lifetime?.active).toBe(false);
    } finally {
      release.resolve();
      await app.dispose();
    }
  });
  it('retains independent concurrent HTTP context and explicit authorization', async () => {
    const contract = defineProcedure({ name: 'context.read', input: z.null(), output: z.string() });
    @Injectable()
    class Handler {
      constructor(@Inject(REQUEST_CONTEXT) readonly context: RequestContext) {}
      @Rpc(contract) async call(_: null) {
        await tick();
        return this.context.request.headers.get('x-tenant') ?? '';
      }
    }
    @Module({ providers: [Handler] })
    class App {}
    const app = await VelaFactory.create(App, {
      adapters: [
        rpcAdapter({
          authorize: (context) => context.getRequest().headers.get('authorization') === 'allowed',
        }),
      ],
      diagnostics: 'silent',
    });
    try {
      await expect(client(app).call(contract, null)).rejects.toMatchObject({ status: 403 });
      const results = await Promise.all(
        ['one', 'two'].map((tenant) =>
          client(app).call(contract, null, {
            headers: { authorization: 'allowed', 'x-tenant': tenant },
          }),
        ),
      );
      expect(results).toEqual(['one', 'two']);
    } finally {
      await app.dispose();
    }
  });
  it('keeps validator exceptions internal and disposes handlers that throw', async () => {
    let disposed = 0;
    const validatorFailure = defineProcedure({
      name: 'failure.validate',
      input: z.string().refine(() => {
        throw new Error('validator secret');
      }),
      output: z.string(),
    });
    const handlerFailure = defineProcedure({
      name: 'failure.handler',
      input: z.string(),
      output: z.string(),
    });
    @Injectable({ scope: Scope.REQUEST })
    class Handler {
      @Rpc(validatorFailure) validate(x: string) {
        return x;
      }
      @Rpc(handlerFailure) call(_: string): string {
        throw new Error('handler secret');
      }
      dispose() {
        disposed++;
      }
    }
    @Module({ providers: [Handler] })
    class App {}
    const app = await VelaFactory.create(App, {
      adapters: [rpcAdapter({ authorize: 'public' })],
      diagnostics: 'silent',
    });
    try {
      await expect(client(app).call(validatorFailure, '')).rejects.toMatchObject({
        status: 500,
        message: 'Internal Server Error',
      });
      expect(disposed).toBe(0);
      await expect(client(app).call(handlerFailure, '')).rejects.toMatchObject({
        status: 500,
        message: 'Internal Server Error',
      });
      await tick();
      expect(disposed).toBe(1);
    } finally {
      await app.dispose();
    }
  });
  it('does not convert an exception filter denial into RPC success', async () => {
    const contract = defineProcedure({
      name: 'filter.denied',
      input: z.null(),
      output: z.string(),
    });
    const filter: ExceptionFilter = {
      catch() {
        return new Response('filtered detail', { status: 429 });
      },
    };
    @Injectable()
    class Handler {
      @Rpc(contract) @UseFilters(filter) call(_: null): string {
        throw new Error('hidden');
      }
    }
    @Module({ providers: [Handler] })
    class App {}
    const app = await VelaFactory.create(App, {
      adapters: [rpcAdapter({ authorize: 'public' })],
      diagnostics: 'silent',
    });
    try {
      await expect(client(app).call(contract, null)).rejects.toMatchObject({
        name: 'RpcError',
        status: 429,
      });
    } finally {
      await app.dispose();
    }
  });

  it('keeps an explicit filter status and renders exception-owned responses', async () => {
    const explicit = defineProcedure({
      name: 'filter.explicit',
      input: z.null(),
      output: z.string(),
    });
    const owned = defineProcedure({ name: 'error.owned', input: z.null(), output: z.string() });
    const coded = defineProcedure({ name: 'error.coded', input: z.null(), output: z.string() });
    const malformed = defineProcedure({
      name: 'error.malformed',
      input: z.null(),
      output: z.string(),
    });
    const internal = defineProcedure({
      name: 'error.internal',
      input: z.null(),
      output: z.string(),
    });
    const foreign = defineProcedure({
      name: 'error.foreign',
      input: z.null(),
      output: z.string(),
    });
    class LockedError extends HttpException {
      constructor() {
        super('hidden', 409);
      }
      override toResponse(): HttpErrorResponse {
        return { status: 409, body: { locked: 'internal lock owner' } };
      }
    }
    // Not a framework exception: its toResponse() is never used.
    class ForeignLockError extends Error {
      toResponse(): HttpErrorResponse {
        return { status: 409, body: { locked: 'internal lock owner' } };
      }
    }
    // An owned body with an `error: { code, message }` member, as CRUD's envelope has.
    class CodedLockError extends HttpException {
      readonly wireCode: string;

      constructor(wireCode: string) {
        super('hidden', 409);
        this.wireCode = wireCode;
      }

      override toResponse(): HttpErrorResponse {
        return {
          status: 409,
          body: {
            success: false,
            error: { code: this.wireCode, message: 'Record locked', owner: 'internal lock owner' },
          },
        };
      }
    }
    const filter: ExceptionFilter = {
      catch() {
        return { status: 422, body: { retry: false } };
      },
    };
    @Injectable()
    class Handler {
      @Rpc(explicit) @UseFilters(filter) call(_: null): string {
        throw new Error('hidden');
      }
      @Rpc(owned) locked(_: null): string {
        throw new LockedError();
      }
      @Rpc(foreign) foreign(_: null): string {
        throw new ForeignLockError('hidden');
      }
      @Rpc(coded) coded(_: null): string {
        throw new CodedLockError('locked');
      }
      @Rpc(malformed) malformed(_: null): string {
        throw new CodedLockError('not a code');
      }
      @Rpc(internal) internal(_: null): string {
        throw new CodedLockError('internal');
      }
    }
    @Module({ providers: [Handler] })
    class App {}
    const app = await VelaFactory.create(App, {
      adapters: [rpcAdapter({ authorize: 'public' })],
      diagnostics: 'silent',
    });
    try {
      await expect(client(app).call(explicit, null)).rejects.toMatchObject({
        name: 'RpcError',
        status: 422,
      });
      const response = await app.fetch(request(owned.name, null));
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body).toMatchObject({
        ok: false,
        error: { code: 'conflict', message: 'RPC request failed', status: 409 },
      });
      expect(JSON.stringify(body)).not.toContain('internal lock owner');
      // Another error's toResponse() owns nothing: it is an internal failure.
      const foreignResponse = await app.fetch(request(foreign.name, null));
      expect(foreignResponse.status).toBe(500);
      expect(await foreignResponse.json()).toMatchObject({
        ok: false,
        error: { code: 'internal', message: 'Internal Server Error', status: 500 },
      });
      // Such a body keeps its code and message, and nothing else.
      const codedResponse = await app.fetch(request(coded.name, null));
      expect(codedResponse.status).toBe(409);
      const codedBody = await codedResponse.json();
      expect(codedBody).toMatchObject({
        ok: false,
        error: { code: 'locked', message: 'Record locked', status: 409 },
      });
      expect(JSON.stringify(codedBody)).not.toContain('internal lock owner');
      // A malformed code becomes the status's code; the message stays.
      expect(await (await app.fetch(request(malformed.name, null))).json()).toMatchObject({
        error: { code: 'conflict', message: 'Record locked', status: 409 },
      });
      // An `internal` code always carries the generic message.
      expect(await (await app.fetch(request(internal.name, null))).json()).toMatchObject({
        error: { code: 'internal', message: 'Internal Server Error', status: 409 },
      });
    } finally {
      await app.dispose();
    }
  });

  it('executes transforms once, preserves #private receivers and request disposal', async () => {
    let inputs = 0;
    let outputs = 0;
    let constructions = 0;
    let disposals = 0;
    const contract = defineProcedure({
      name: 'math.double',
      input: z.string().transform(async (x) => {
        inputs++;
        return Number(x);
      }),
      output: z.number().transform(async (x) => {
        outputs++;
        return { value: x * 2 };
      }),
    });
    @Injectable({ scope: Scope.REQUEST })
    class MathService {
      #factor = 1;
      constructor() {
        constructions++;
      }
      @Rpc(contract)
      double(value: number) {
        return value * this.#factor;
      }
      dispose() {
        disposals++;
      }
    }
    @Module({ providers: [MathService] })
    class App {}
    const app = await VelaFactory.create(App, {
      adapters: [rpcAdapter({ authorize: 'public' })],
      diagnostics: 'silent',
    });
    try {
      expect(constructions).toBe(0);
      expect(await client(app).call(contract, '21')).toEqual({ value: 42 });
      expect(await client(app).call(contract, '2')).toEqual({ value: 4 });
      await tick();
      expect([inputs, outputs, constructions, disposals]).toEqual([2, 2, 2, 2]);
    } finally {
      await app.dispose();
    }
  });
  it('runs global and owner-scoped guards before parsing or provider construction', async () => {
    const events: string[] = [];
    const contract = defineProcedure({
      name: 'secure.call',
      input: z.string().transform((x) => {
        events.push('parse');
        return x;
      }),
      output: z.string(),
    });
    @Injectable({ scope: Scope.REQUEST })
    class Secret {
      constructor() {
        events.push('construct');
      }
      @Rpc(contract)
      @UseGuards({
        canActivate: () => {
          events.push('method');
          return false;
        },
      })
      call(input: string) {
        events.push('invoke');
        return input;
      }
    }
    const global: CanActivate = {
      canActivate(context) {
        expect(context.getClass()).toBe(Secret);
        expect(context.getType()).toBe('http');
        expect(context.getModuleId()).toBe('App#default');
        events.push('global');
        return true;
      },
    };
    @Module({ providers: [Secret, defineProvider(APP_GUARD, { useValue: global })] })
    class App {}
    const app = await VelaFactory.create(App, {
      adapters: [rpcAdapter({ authorize: 'public' })],
      diagnostics: 'silent',
    });
    try {
      await expect(client(app).call(contract, 'secret')).rejects.toMatchObject({ status: 403 });
      expect(events).toEqual(['global', 'method']);
    } finally {
      await app.dispose();
    }
  });
  it('isolates the same guard and service tokens registered in different modules', async () => {
    const owner = new InjectionToken<string>('owner');
    const first = defineProcedure({ name: 'one.read', input: z.null(), output: z.string() });
    const second = defineProcedure({ name: 'two.read', input: z.null(), output: z.string() });
    @Injectable()
    class Guard implements CanActivate {
      constructor(@Inject(owner) readonly label: string) {}
      canActivate(context: ExecutionContext) {
        return context.getRequest().headers.get('x-owner') === this.label;
      }
    }
    @Injectable({ scope: Scope.REQUEST })
    class Store {
      constructor(@Inject(owner) readonly label: string) {}
    }
    @Injectable()
    class One {
      constructor(@Inject(Store) readonly store: Store) {}
      @Rpc(first) @UseGuards(Guard) read(_: null) {
        return this.store.label;
      }
    }
    @Injectable()
    class Two {
      constructor(@Inject(Store) readonly store: Store) {}
      @Rpc(second) @UseGuards(Guard) read(_: null) {
        return this.store.label;
      }
    }
    @Module({ providers: [One, Store, Guard, defineProvider(owner, { useValue: 'one' })] })
    class M1 {}
    @Module({ providers: [Two, Store, Guard, defineProvider(owner, { useValue: 'two' })] })
    class M2 {}
    @Module({ imports: [M1, M2] })
    class App {}
    const app = await VelaFactory.create(App, {
      adapters: [rpcAdapter({ authorize: 'public' })],
      diagnostics: 'silent',
    });
    try {
      expect(await client(app).call(first, null, { headers: { 'x-owner': 'one' } })).toBe('one');
      expect(await client(app).call(second, null, { headers: { 'x-owner': 'two' } })).toBe('two');
      await expect(
        client(app).call(second, null, { headers: { 'x-owner': 'one' } }),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      await app.dispose();
    }
  });
  it('supports async providers in a lazy owning module without eager construction', async () => {
    let initialized = 0;
    const value = new InjectionToken<string>('async value');
    const contract = defineProcedure({ name: 'lazy.value', input: z.null(), output: z.string() });
    @Injectable()
    class Handler {
      constructor(@Inject(value) readonly result: string) {
        initialized++;
      }
      @Rpc(contract) call(_: null) {
        return this.result;
      }
    }
    @Module({
      lazy: true,
      providers: [Handler, defineProvider(value, { useFactory: async () => 'loaded' })],
    })
    class Lazy {}
    @Module({ imports: [Lazy] })
    class App {}
    const app = await VelaFactory.create(App, {
      adapters: [rpcAdapter({ authorize: 'public' })],
      diagnostics: 'silent',
    });
    try {
      expect(initialized).toBe(0);
      expect(await client(app).call(contract, null)).toBe('loaded');
      expect(initialized).toBe(1);
    } finally {
      await app.dispose();
    }
  });
  it('validates interceptor results and redacts unknown errors or non-JSON output', async () => {
    const contract = defineProcedure({ name: 'result.read', input: z.null(), output: z.string() });
    const reports: unknown[] = [];
    const replace: NestInterceptor = {
      async intercept() {
        return { secret: 'invalid' };
      },
    };
    @Injectable()
    class Handler {
      @Rpc(contract) @UseInterceptors(replace) call(_: null) {
        return 'valid';
      }
    }
    @Module({
      providers: [
        Handler,
        defineProvider(APP_EXCEPTION_HANDLER, {
          useValue: {
            report: (e: unknown) => {
              reports.push(e);
            },
          },
        }),
      ],
    })
    class App {}
    const app = await VelaFactory.create(App, {
      adapters: [rpcAdapter({ authorize: 'public' })],
      diagnostics: 'silent',
    });
    try {
      await expect(client(app).call(contract, null)).rejects.toMatchObject({
        code: 'internal',
        status: 500,
        message: 'Internal Server Error',
      });
      expect(reports).toHaveLength(1);
    } finally {
      await app.dispose();
    }
    for (const output of [
      1n,
      undefined,
      new Date(),
      (() => {
        const x: Record<string, unknown> = {};
        x.x = x;
        return x;
      })(),
    ]) {
      const bad = defineProcedure({ name: 'bad.output', input: z.null(), output: z.unknown() });
      @Injectable()
      class Bad {
        @Rpc(bad) call(_: null) {
          return output;
        }
      }
      @Module({ providers: [Bad] })
      class BadApp {}
      const badApp = await VelaFactory.create(BadApp, {
        adapters: [rpcAdapter({ authorize: 'public' })],
        diagnostics: 'silent',
      });
      try {
        await expect(client(badApp).call(bad, null)).rejects.toMatchObject({
          code: 'internal',
          status: 500,
        });
      } finally {
        await badApp.dispose();
      }
    }
  });
  it('isolates application registries when reusing the adapter configuration', async () => {
    const contract = defineProcedure({ name: 'app.only', input: z.null(), output: z.string() });
    @Injectable()
    class Handler {
      @Rpc(contract) call(_: null) {
        return 'A';
      }
    }
    @Module({ providers: [Handler] })
    class A {}
    @Module({})
    class B {}
    const adapter = rpcAdapter({ authorize: 'public' });
    const a = await VelaFactory.create(A, { adapters: [adapter], diagnostics: 'silent' });
    const b = await VelaFactory.create(B, { adapters: [adapter], diagnostics: 'silent' });
    try {
      expect(await client(a).call(contract, null)).toBe('A');
      await expect(client(b).call(contract, null)).rejects.toMatchObject({ status: 404 });
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });
  it('rejects duplicate names and invalid exposure configuration at startup', async () => {
    const contract = defineProcedure({ name: 'same.name', input: z.null(), output: z.null() });
    @Injectable()
    class A {
      @Rpc(contract) call(_: null) {
        return null;
      }
    }
    @Injectable()
    class B {
      @Rpc(contract) call(_: null) {
        return null;
      }
    }
    @Module({ providers: [A, B] })
    class App {}
    await expect(
      VelaFactory.create(App, {
        adapters: [rpcAdapter({ authorize: 'public' })],
        diagnostics: 'silent',
      }),
    ).rejects.toThrow('Duplicate RPC procedure');
    expect(() => rpcAdapter({ authorize: undefined as never })).toThrow('explicit authorize');
  });
  it('returns invalid input as 400 and rejects unannotated methods', async () => {
    const contract = defineProcedure({ name: 'input.read', input: z.string(), output: z.string() });
    @Injectable()
    class Handler {
      @Rpc(contract) call(x: string) {
        return x;
      }
      hidden() {
        return 'secret';
      }
    }
    @Module({ providers: [Handler] })
    class App {}
    const app = await VelaFactory.create(App, {
      adapters: [rpcAdapter({ authorize: 'public' })],
      diagnostics: 'silent',
    });
    try {
      const res = await app.fetch(request(contract.name, 9));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        version: 1,
        id: 'call',
        procedure: contract.name,
        ok: false,
        error: { code: 'bad_request', message: 'RPC input validation failed', status: 400 },
      });
      const missing = await app.fetch(request('input.hidden', null));
      expect(missing.status).toBe(404);
      await missing.text();
      const malformed = await app.fetch(
        new Request('https://rpc.test/rpc', { method: 'POST', body: '{}' }),
      );
      expect(malformed.status).toBe(400);
      await malformed.text();
    } finally {
      await app.dispose();
    }
  });
  it('redacts 5xx HttpException text and derives codes from the status', async () => {
    const contract = defineProcedure({ name: 'status.throw', input: z.number(), output: z.null() });
    @Injectable()
    class Handler {
      @Rpc(contract) call(status: number): null {
        throw new HttpException(`caller detail for ${status}`, status);
      }
    }
    @Module({ providers: [Handler] })
    class App {}
    const app = await VelaFactory.create(App, {
      adapters: [rpcAdapter({ authorize: 'public' })],
      diagnostics: 'silent',
    });
    const cases: Array<[number, { code: string; message: string }]> = [
      [500, { code: 'internal', message: 'Internal Server Error' }],
      [502, { code: 'bad_gateway', message: 'Bad Gateway' }],
      [507, { code: 'internal', message: 'Internal Server Error' }],
      [406, { code: 'not_acceptable', message: 'caller detail for 406' }],
      [428, { code: 'precondition_required', message: 'caller detail for 428' }],
      [418, { code: 'bad_request', message: 'caller detail for 418' }],
    ];
    try {
      for (const [status, error] of cases) {
        const res = await app.fetch(request(contract.name, status));
        expect(res.status).toBe(status);
        expect(await res.json()).toEqual({
          version: 1,
          id: 'call',
          procedure: contract.name,
          ok: false,
          error: { ...error, status },
        });
      }
    } finally {
      await app.dispose();
    }
  });
});
