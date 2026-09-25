import { describe, expect, it, vi } from 'vitest';
import { Context } from 'hono';
import type { Token } from '@velajs/vela';
import type { InferToken } from '@velajs/vela/module-kit';
import {
  APP_EXCEPTION_HANDLER,
  Injectable,
  defineProvider,
  Controller,
  Get,
  Module,
  VelaFactory,
} from '@velajs/vela';
import { APP_LOGGER, ApplicationLogger, LoggingModule } from '@velajs/vela/logging';
import {
  Container,
  buildEntrypointExecutionContext,
  createExecutionScope,
} from '@velajs/vela/module-kit';
import { parseStudioRpcResponse } from '@velajs/studio-protocol';
import { AdminLogBuffer, AdminRpc, StudioModule } from '../src';
import { StudioDispatchRegistry } from '../src/rpc/dispatch.registry';
import { ConfirmTokenSigner } from '../src/security/confirm-token';
import { AdminAuditLog } from '../src/audit/audit-log';
import { StudioLogCapture, StudioTimingInterceptor, logsPanel } from '../src/logging';

const rpcOptions: RequestInit = {
  method: 'POST',
  headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
  body: '{}',
};

async function appWithLogging(timings = false) {
  const studio = StudioModule.forRoot({
    token: 'test-token',
    logBufferSize: 3,
    plugins: [logsPanel({ timings })],
  });
  const logging = LoggingModule.forRoot({ sinks: [] });
  @Controller('/hello')
  class Hello {
    @Get() get() {
      return 'hello';
    }
  }
  @Module({
    imports: [studio, logging],
    controllers: [Hello],
  })
  class App {}
  return VelaFactory.create(App);
}

describe('application-owned Studio log capture', () => {
  it('captures redacted structured records through authenticated RPC without crossing apps', async () => {
    const [one, two] = await Promise.all([appWithLogging(), appWithLogging()]);
    try {
      const logger = one.get(APP_LOGGER);
      logger
        .createLogger('orders', { password: 'never-wire', order: { id: 3n } })
        .warn('created', { authorization: 'Bearer secret' });
      await logger.flush();
      const response = await one.getHonoApp().request('/_vela/admin/rpc/logs.tail', rpcOptions);
      const result = parseStudioRpcResponse('logs.tail', await response.json());
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected captured logs');
      expect(result.data).toMatchObject([{ level: 'warn', source: 'orders', msg: 'created' }]);
      expect(JSON.stringify(result)).not.toContain('never-wire');
      expect(JSON.stringify(result)).not.toContain('Bearer secret');
      expect(two.get(AdminLogBuffer).size).toBe(0);
      expect(
        (await one.getHonoApp().request('/_vela/admin/rpc/logs.tail', { method: 'POST' })).status,
      ).toBe(401);
    } finally {
      await Promise.all([one.close(), two.close()]);
    }
  });

  it('registers the timing interceptor only with inert-by-default behavior', async () => {
    const disabled = await appWithLogging();
    const enabled = await appWithLogging(true);
    try {
      await disabled.getHonoApp().request('/hello');
      await enabled.getHonoApp().request('/hello');
      expect(disabled.get(AdminLogBuffer).size).toBe(0);
      expect(enabled.get(AdminLogBuffer).tail()).toMatchObject([
        {
          invocation: {
            kind: 'http',
            source: 'Hello#get',
            moduleId: 'App#default',
            outcome: 'returned',
            boundary: 'handler',
          },
        },
      ]);
    } finally {
      await disabled.close();
      await enabled.close();
    }
  });

  it('initializes idempotently and unsubscribes on destroy', async () => {
    const logger = new ApplicationLogger({ sinks: [] });
    const buffer = new AdminLogBuffer(2);
    const capture = new StudioLogCapture(logger, buffer);
    capture.onModuleInit();
    capture.onModuleInit();
    logger.createLogger().log('one');
    await logger.flush();
    expect(buffer.size).toBe(1);
    capture.onModuleDestroy();
    capture.onModuleDestroy();
    logger.createLogger().log('two');
    await logger.flush();
    expect(buffer.size).toBe(1);
  });

  it('retains validated timing metadata only and never treats user fields as authority', async () => {
    const logger = new ApplicationLogger({ sinks: [] });
    const buffer = new AdminLogBuffer(2);
    const capture = new StudioLogCapture(logger, buffer);
    capture.onModuleInit();
    logger
      .createLogger('studio.invocation', { studioInvocation: { elapsedMs: -1 } })
      .log('invalid');
    await logger.flush();
    expect(buffer.tail()[0]?.invocation).toBeUndefined();
    capture.onModuleDestroy();
  });
});

describe('bounded, isolated log buffers', () => {
  it('copies inputs and results and safely snapshots hostile fields', () => {
    const buffer = new AdminLogBuffer(2);
    const getter = vi.fn(() => 'secret');
    const fields = { nested: { value: 'original' }, bigint: 2n };
    Object.defineProperty(fields, 'secret', { get: getter, enumerable: true });
    buffer.record({ ts: 1, level: 'info', msg: 'a', fields });
    fields.nested.value = 'mutated';
    const first = buffer.tail();
    expect(first[0]?.fields).toEqual({
      nested: { value: 'original' },
      bigint: '2n',
      secret: '[accessor]',
    });
    first[0]!.fields!.nested = 'changed';
    expect(buffer.tail()[0]?.fields?.nested).toEqual({ value: 'original' });
    expect(getter).not.toHaveBeenCalled();
    expect(Object.keys(buffer)).toEqual([]);
    buffer.record({ ts: 2, level: 'warn', msg: 'b' });
    buffer.record({ ts: 3, level: 'error', msg: 'c' });
    expect(buffer.tail().map((entry) => entry.msg)).toEqual(['c', 'b']);
    expect(buffer.tail({ level: 'warn', limit: 1 })).toHaveLength(1);
  });
  it('validates capacity and supports disabling capture', () => {
    for (const size of [-1, NaN, 0.5, Infinity])
      expect(() => new AdminLogBuffer(size)).toThrow(RangeError);
    const buffer = new AdminLogBuffer(0);
    buffer.record({ ts: 1, level: 'info', msg: 'disabled' });
    expect(buffer.size).toBe(0);
  });
});

describe('honest handler completion timing', () => {
  it('correlates concurrent scopes and preserves errors without recording their payload', async () => {
    const logger = new ApplicationLogger({ sinks: [] });
    const buffer = new AdminLogBuffer(5);
    const capture = new StudioLogCapture(logger, buffer);
    capture.onModuleInit();
    const interceptor = new StudioTimingInterceptor(logger, true);
    class Handler {}
    const scopes = [createExecutionScope(new Container()), createExecutionScope(new Container())];
    const error = new Error('private-error');
    const results = await Promise.allSettled(
      scopes.map((scope, index) =>
        interceptor.intercept(
          buildEntrypointExecutionContext(
            'queue',
            Handler,
            'run',
            undefined,
            `owner-${index}`,
            scope.container,
          ),
          {
            handle: async () => {
              if (index === 1) throw error;
              return new Response('streamed later');
            },
          },
        ),
      ),
    );
    expect(results[1]).toEqual({ status: 'rejected', reason: error });
    await Promise.all(scopes.map((scope) => scope.finish()));
    const rows = buffer.tail();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((entry) => entry.invocation?.invocationId))).toEqual(
      new Set(scopes.map((scope) => scope.lifetime.id)),
    );
    expect(rows.map((row) => row.invocation?.outcome).toSorted()).toEqual(['returned', 'threw']);
    expect(
      rows.every((row) => row.invocation!.elapsedMs >= 0 && row.invocation!.boundary === 'handler'),
    ).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('private-error');
    capture.onModuleDestroy();
  });
});

describe('Studio exception boundary', () => {
  it('reports a correlated server error once, redacts its wire body, and honors reporter policy', async () => {
    const logging = new ApplicationLogger({ sinks: [] });
    const buffer = new AdminLogBuffer(10);
    const capture = new StudioLogCapture(logging, buffer);
    capture.onModuleInit();
    const error = new Error('private-server-message', { cause: { password: 'private-password' } });
    @Injectable()
    class Failing {
      @AdminRpc({ op: 'app.routes' }) run() {
        throw error;
      }
    }
    const container = new Container();
    container.register(Failing);
    container.register(defineProvider(APP_LOGGER, { useValue: logging }));
    const registry = new StudioDispatchRegistry(
      container,
      new ConfirmTokenSigner('token'),
      new AdminAuditLog(10),
    );
    registry.onApplicationBootstrap();
    const ctx = {
      http: new Context(new Request('https://studio.test/')),
      admin: { subject: 'master', via: 'master-token' as const, ip: null },
      editable: {
        data: false,
        schema: false,
        identity: false,
        ops: false,
        timeTravel: false,
        transfer: false,
      },
      audit: () => {},
      get: <K extends Token>(token: K): InferToken<K> => container.resolve(token),
    };
    const response = await registry.dispatch('app.routes', {}, ctx);
    await logging.flush();
    expect(response).toMatchObject({ ok: false, status: 500 });
    expect(JSON.stringify(response)).not.toContain('private-server-message');
    expect(buffer.tail()).toHaveLength(1);
    expect(buffer.tail()[0]).toMatchObject({
      source: 'exception',
      level: 'error',
      fields: { invocationId: expect.any(String), edge: 'rpc', source: 'studio.app.routes' },
    });
    expect(JSON.stringify(buffer.tail())).not.toContain('private-password');
    const report = vi.fn();
    container.register(defineProvider(APP_EXCEPTION_HANDLER, { useValue: { report } }));
    await registry.dispatch('app.routes', {}, ctx);
    expect(report).toHaveBeenCalledOnce();
    expect(buffer.size).toBe(1);
    container.register(
      defineProvider(APP_EXCEPTION_HANDLER, { useValue: { report, dontReport: [() => true] } }),
    );
    await registry.dispatch('app.routes', {}, ctx);
    expect(report).toHaveBeenCalledOnce();
    expect(buffer.size).toBe(1);
    capture.onModuleDestroy();
  });
});

describe('logsPanel()', () => {
  it('names LoggingModule when the application has no logger', async () => {
    @Module({ imports: [StudioModule.forRoot({ token: 'test-token', plugins: [logsPanel()] })] })
    class App {}
    await expect(VelaFactory.create(App)).rejects.toThrow(
      'logsPanel() captures the application logger: import LoggingModule.forRoot()',
    );
  });
});
