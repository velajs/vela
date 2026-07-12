import { describe, expect, it, vi } from 'vitest';
import { resolveErrorReporter } from '../exceptions/reporter';
import { APP_EXCEPTION_HANDLER, ERROR_CATALOG } from '../pipeline/tokens';
import { Container } from '../container/container';
import { defineErrorCatalog, VelaError } from '@velajs/errors';
import { InternalServerErrorException, NotFoundException } from '../errors/http-exception';

describe('ErrorReporter', () => {
  it('default reporter console.errors unless diagnostics is silent', () => {
    const container = new Container();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    resolveErrorReporter(container).report(new Error('boom'), { edge: 'http', source: 'X.y' });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('default reporter skips 4xx client-fault errors (no console noise)', () => {
    const container = new Container();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reporter = resolveErrorReporter(container);
    reporter.report(new NotFoundException('missing thing'), { edge: 'http' });
    reporter.report(new VelaError('not_found'), { edge: 'http' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('default reporter still logs 5xx and unbranded errors', () => {
    const container = new Container();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reporter = resolveErrorReporter(container);
    reporter.report(new InternalServerErrorException('boom'), { edge: 'http' });
    reporter.report(new VelaError('internal'), { edge: 'http' });
    reporter.report(new Error('raw'), { edge: 'http' });
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it('custom handler.report still receives 4xx errors (skip is default-console-only)', () => {
    const container = new Container();
    const report = vi.fn();
    container.register({ provide: APP_EXCEPTION_HANDLER, useValue: { report } });
    resolveErrorReporter(container).report(new NotFoundException('missing thing'), { edge: 'http' });
    expect(report).toHaveBeenCalledOnce();
  });

  it('custom handler.report always runs, even under diagnostics silent', () => {
    // Diagnostics has no setter — it is a constructor option (see container.ts).
    const container = new Container({ diagnostics: 'silent' });
    const report = vi.fn();
    container.register({ provide: APP_EXCEPTION_HANDLER, useValue: { report } });
    resolveErrorReporter(container).report(new Error('boom'), { edge: 'http' });
    expect(report).toHaveBeenCalledOnce();
  });

  it('dontReport suppresses by code, class, and predicate', () => {
    const container = new Container();
    const report = vi.fn();
    container.register({
      provide: APP_EXCEPTION_HANDLER,
      useValue: { report, dontReport: ['not_found', (e: unknown) => (e as Error).message === 'skip'] },
    });
    const reporter = resolveErrorReporter(container);
    reporter.report(new VelaError('not_found'), { edge: 'http' });
    reporter.report(new Error('skip'), { edge: 'http' });
    reporter.report(new Error('loud'), { edge: 'http' });
    expect(report).toHaveBeenCalledOnce();
  });

  it('a throwing report() is contained and never propagates', () => {
    const container = new Container();
    container.register({
      provide: APP_EXCEPTION_HANDLER,
      useValue: { report: () => { throw new Error('reporter bug'); } },
    });
    expect(() => resolveErrorReporter(container).report(new Error('x'), { edge: 'http' })).not.toThrow();
  });

  it('a throwing dontReport matcher never escapes report() and the error is still reported', () => {
    const container = new Container();
    const report = vi.fn();
    container.register({
      provide: APP_EXCEPTION_HANDLER,
      useValue: {
        report,
        dontReport: [() => { throw new Error('broken matcher'); }],
      },
    });
    const reporter = resolveErrorReporter(container);
    expect(() => reporter.report(new Error('original'), { edge: 'http' })).not.toThrow();
    expect(report).toHaveBeenCalledOnce();
  });

  it('exposes the composed ERROR_CATALOG when provided', () => {
    const container = new Container();
    const catalog = defineErrorCatalog({ order_expired: { status: 410, title: 'Order expired' } });
    container.register({ provide: ERROR_CATALOG, useValue: catalog });
    expect(resolveErrorReporter(container).catalog.has('order_expired')).toBe(true);
  });
});
