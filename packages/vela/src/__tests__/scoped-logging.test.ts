import { describe, expect, it, vi } from 'vitest';
import { Container } from '../container/container';
import { defineProvider } from '../container/types';
import { Scope } from '../constants';
import { createExecutionScope, runInEntrypointScope } from '../entrypoint/execution-scope';
import { REQUEST_CONTEXT, createRequestContext } from '../http/request-context';
import { loggerForScope } from '../logging/scoped-logger';
import { APP_LOGGER } from '../logging/logging.module';
import { ApplicationLogger } from '../logging/application-logger';
import { APP_EXCEPTION_HANDLER } from '../pipeline/tokens';
import { resolveErrorReporter } from '../exceptions/reporter';
import { NotFoundException } from '../errors/http-exception';
import { Hono } from 'hono';
import type { LogRecord, LogSink } from '../logging/log.types';
import type { ErrorReportContext } from '../exceptions/exception-handler';

function root(sink: LogSink, diagnostics: 'log' | 'silent' = 'log') {
  const container = new Container({ diagnostics });
  container.register(
    defineProvider(APP_LOGGER, { useValue: new ApplicationLogger({ sinks: [sink] }) }),
  );
  return container;
}

describe('invocation logging and exception integration', () => {
  it('correlates concurrent scopes and completes sink delivery before request disposal', async () => {
    const records: LogRecord[] = [];
    const order: string[] = [];
    const container = root(async (record) => {
      await Promise.resolve();
      records.push(record);
      order.push('delivered');
    });
    class Resource {
      dispose() {
        order.push('disposed');
      }
    }
    container.register(
      defineProvider(Resource, { scope: Scope.REQUEST, useFactory: () => new Resource() }),
    );
    await Promise.all(
      ['first', 'second'].map((name) =>
        runInEntrypointScope(container, async (scope, lifetime) => {
          scope.resolve(Resource);
          const log = loggerForScope(scope, 'job', { name, invocationId: 'spoofed' });
          await Promise.resolve();
          log.log('hello');
          expect(lifetime.active).toBe(true);
        }),
      ),
    );
    expect(records).toHaveLength(2);
    expect(new Set(records.map((r) => r.fields.invocationId)).size).toBe(2);
    expect(
      records.every(
        (r) => typeof r.fields.invocationId === 'string' && r.fields.invocationId !== 'spoofed',
      ),
    ).toBe(true);
    expect(order.slice(0, 2)).toEqual(['delivered', 'delivered']);
    expect(order.slice(2)).toEqual(['disposed', 'disposed']);
  });

  it('stops a retained scoped logger when its invocation closes', async () => {
    const sink = vi.fn();
    const scope = createExecutionScope(root(sink));
    const logger = loggerForScope(scope.container);
    logger.log('inside');
    await scope.finish();
    logger.log('expired');
    expect(sink).toHaveBeenCalledOnce();
    expect(() => loggerForScope(scope.container)).toThrow('closed');
  });

  it('uses existing HTTP RequestContext id without interpreting headers independently', async () => {
    const records: LogRecord[] = [];
    const container = root((record) => {
      records.push(record);
    });
    container.register(
      defineProvider(REQUEST_CONTEXT, {
        scope: Scope.REQUEST,
        inject: [],
        useFactory: () => {
          throw new Error('HTTP only');
        },
      }),
    );
    const hono = new Hono();
    hono.get('/', async (c) => {
      const scope = createExecutionScope(container);
      const context = createRequestContext(c);
      scope.container.setRequestInstance(REQUEST_CONTEXT, context);
      loggerForScope(scope.container).withFields({ requestId: 'spoofed' }).log('request');
      await scope.finish();
      return c.text(context.id);
    });
    const response = await hono.request('/', { headers: { 'x-request-id': 'existing-id' } });
    expect(await response.text()).toBe('existing-id');
    expect(records[0]?.fields.requestId).toBe('existing-id');
    expect(records[0]?.fields.invocationId).toEqual(expect.any(String));
    loggerForScope(container).log('outside HTTP');
    expect(records[1]?.fields).toEqual({});
  });

  it('routes a default error once to redacted sinks with correlation and no raw console fallback', async () => {
    const records: LogRecord[] = [];
    const container = root((record) => {
      records.push(record);
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runInEntrypointScope(container, (scope, lifetime) => {
        const reporter = resolveErrorReporter(scope);
        reporter.report(Object.assign(new Error('failed'), { token: 'secret' }), {
          edge: 'queue',
          source: 'Orders.process',
          invocationId: 'spoofed',
        });
        reporter.report(new NotFoundException(), { edge: 'http' });
        expect(records[0]?.fields.invocationId).toBe(lifetime.id);
      });
      expect(records).toHaveLength(1);
      expect(records[0]?.fields.source).toBe('Orders.process');
      expect(JSON.stringify(records)).not.toContain('secret');
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('preserves custom reporting as a replacement, tracks its async work and contains failure', async () => {
    const sink = vi.fn();
    const container = root(sink, 'silent');
    const calls: ErrorReportContext[] = [];
    const raw = new Error('original');
    let completed = false;
    container.register(
      defineProvider(APP_EXCEPTION_HANDLER, {
        useValue: {
          context: () => ({ custom: true, invocationId: 'spoofed' }),
          report: async (error: unknown, ctx: ErrorReportContext) => {
            expect(error).toBe(raw);
            calls.push(ctx);
            // oxlint-disable-next-line promise/no-promise-in-callback -- Exercise asynchronous reporting.
            await Promise.resolve();
            completed = true;
            throw new Error('reporter failed');
          },
        },
      }),
    );
    await runInEntrypointScope(container, (scope, lifetime) => {
      resolveErrorReporter(scope).report(raw, { edge: 'graphql' });
      expect(calls[0]?.invocationId).toBe(lifetime.id);
    });
    expect(completed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.custom).toBe(true);
    expect(sink).not.toHaveBeenCalled();
  });

  it('preserves dontReport and default diagnostics-silent suppression', () => {
    const sink = vi.fn();
    const silent = root(sink, 'silent');
    resolveErrorReporter(silent).report(new Error('hidden'), { edge: 'rpc' });
    const filtered = root(sink);
    filtered.register(defineProvider(APP_EXCEPTION_HANDLER, { useValue: { dontReport: [Error] } }));
    resolveErrorReporter(filtered).report(new Error('hidden'), { edge: 'http' });
    expect(sink).not.toHaveBeenCalled();
  });
  it('contains failing context accessors and broken sinks without a raw-console retry', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sink = vi.fn(() => {
      throw new Error('sink failure');
    });
    const container = root(sink);
    container.register(
      defineProvider(APP_EXCEPTION_HANDLER, {
        useValue: {
          context: () => ({
            get secret() {
              throw new Error('context getter');
            },
          }),
        },
      }),
    );
    try {
      await runInEntrypointScope(container, (scope) => {
        expect(() =>
          resolveErrorReporter(scope).report(new Error('original'), { edge: 'http' }),
        ).not.toThrow();
      });
      expect(sink).toHaveBeenCalledOnce();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
  it('retains inert correlation for completion failures reported after scope disposal', async () => {
    const records: LogRecord[] = [];
    const scope = createExecutionScope(
      root((record) => {
        records.push(record);
      }),
    );
    const id = scope.lifetime.id;
    const reporter = resolveErrorReporter(scope.container);
    await scope.finish();
    reporter.report(new Error('completion failed'), { edge: 'http', note: 'completion' });
    expect(records).toHaveLength(1);
    expect(records[0]?.fields.invocationId).toBe(id);
  });
});
