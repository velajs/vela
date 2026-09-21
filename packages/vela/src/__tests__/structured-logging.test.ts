import { describe, expect, it, vi } from 'vitest';
import { ApplicationLogger, consoleLogSink } from '../logging/application-logger';
import { serializeLogValue } from '../logging/log-serialization';
import { parseLogDirective } from '../logging/log-levels';
import { Logger, LogLevel } from '../services/logger';
import type { LogRecord } from '../logging/log.types';

function capture(options: ConstructorParameters<typeof ApplicationLogger>[0] = {}) {
  const records: LogRecord[] = [];
  const app = new ApplicationLogger({
    sinks: [
      (record) => {
        records.push(record);
      },
    ],
    ...options,
  });
  return { app, records, log: app.createLogger('test') };
}

describe('application-owned structured logging', () => {
  it('isolates app levels, contexts, sinks and legacy static configuration', () => {
    const a = capture({ level: LogLevel.DEBUG });
    const b = capture({ level: LogLevel.ERROR });
    const previous = Logger.level;
    Logger.setLogLevel(LogLevel.SILENT);
    try {
      a.log.withFields({ app: 'a' }).debug('visible');
      b.log.debug('hidden');
      b.log.error('visible');
      expect(a.records).toHaveLength(1);
      expect(a.records[0]?.fields).toEqual({ app: 'a' });
      expect(b.records).toHaveLength(1);
      expect(b.records[0]?.fields).toEqual({});
    } finally {
      Logger.setLogLevel(previous);
    }
  });

  it('snapshots child context without retaining caller references or changing parent', () => {
    const { app, records, log } = capture();
    const fields = { nested: { id: 1 }, secret: 'hidden' };
    const child = log.withFields(fields).extend('child');
    fields.nested.id = 2;
    log.log('parent');
    child.log('child');
    expect(records[0]?.fields).toEqual({});
    expect(records[1]?.category).toBe('test:child');
    expect(records[1]?.fields).toEqual({ nested: { id: 1 }, secret: '[Redacted]' });
    expect(Object.keys(app)).toEqual([]);
    expect(Object.keys(child)).toEqual([]);
  });

  it('preserves objects and Error causes and redacts all output paths before any sink', () => {
    const { app, records } = capture({ redactKeys: ['privateNote'] });
    const mirror: LogRecord[] = [];
    app.subscribe((record) => {
      mirror.push(record);
    });
    const cause = Object.assign(new Error('root'), { token: 'cause-secret' });
    const error = Object.assign(new Error('failure', { cause }), { privateNote: 'note-secret' });
    app.createLogger('test', { authorization: 'bearer-secret' }).error(error, {
      password: 'password-secret',
      nested: { cookie: 'cookie-secret' },
      count: 42n,
    });
    const record = records[0]!;
    expect(record.message).toBe('failure');
    expect(record.arguments[0]).toMatchObject({
      name: 'Error',
      message: 'failure',
      privateNote: '[Redacted]',
      cause: { message: 'root', token: '[Redacted]' },
    });
    expect(record.arguments[1]).toEqual({
      password: '[Redacted]',
      nested: { cookie: '[Redacted]' },
      count: '42n',
    });
    expect(mirror[0]).toBe(record);
    expect(JSON.stringify(record)).not.toContain('-secret');
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.fields)).toBe(true);
    expect(Object.isFrozen(record.arguments[0])).toBe(true);
  });

  it('contains failures and recursive sink writes without bypassing other subscribers', async () => {
    const { app, records, log } = capture();
    app.subscribe(() => {
      log.log('recursive');
      throw new Error('sync sink');
    });
    app.subscribe(async () => {
      throw new Error('async sink');
    });
    expect(() => log.log('original')).not.toThrow();
    await app.flush();
    expect(records.map((r) => r.message)).toEqual(['original']);
    expect(app.diagnostics).toEqual({ pending: 0, dropped: 1, failed: 2 });
  });

  it('tracks async deliveries with an invocation callback and bounded pending capacity', async () => {
    let complete!: () => void;
    const delivery = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const sink = vi.fn(() => delivery);
    const app = new ApplicationLogger({ sinks: [sink], maxPending: 1 });
    const waitUntil = vi.fn();
    const log = app.createLogger(
      'job',
      { invocationId: 'wrong' },
      {
        fields: { invocationId: 'owned' },
        waitUntil,
      },
    );
    log.withFields({ invocationId: 'also-wrong' }).log('first');
    log.log('dropped');
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[0]?.fields.invocationId).toBe('owned');
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(app.diagnostics.dropped).toBe(1);
    const flushing = app.flush();
    complete();
    await flushing;
    expect(app.diagnostics.pending).toBe(0);
  });

  it('deduplicates sinks and detaches subscriptions; dispose stops existing children', async () => {
    const sink = vi.fn();
    const app = new ApplicationLogger({ sinks: [sink] });
    const unsubscribe = app.subscribe(sink);
    const observer = vi.fn();
    const stop = app.subscribe(observer);
    const child = app.createLogger();
    child.log('first');
    expect(sink).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledOnce();
    stop();
    stop();
    unsubscribe();
    child.log('second');
    expect(sink).toHaveBeenCalledTimes(2);
    expect(observer).toHaveBeenCalledOnce();
    await app.dispose();
    child.log('third');
    expect(sink).toHaveBeenCalledTimes(2);
    expect(() => app.subscribe(observer)).toThrow('disposed');
  });

  it('uses exact category overrides, exposes enabled checks, and updates atomically', () => {
    const { app, records } = capture({ directive: 'warn,http=debug' });
    const http = app.createLogger('http');
    const other = app.createLogger('other');
    expect(http.isEnabled(LogLevel.DEBUG)).toBe(true);
    expect(other.isEnabled(LogLevel.LOG)).toBe(false);
    expect(() => app.configure('off,http=constructor')).toThrow();
    http.debug('still enabled');
    expect(records).toHaveLength(1);
    const truncated = capture({ maxStringLength: 3, directive: 'error,long-category=debug' });
    truncated.app.createLogger('long-category').debug('visible');
    expect(truncated.records[0]?.category).toBe('lon[Truncated]');
    app.configure('http=error');
    http.warn('hidden');
    expect(records).toHaveLength(1);
    for (const invalid of ['constructor', '__proto__', '=debug', 'a=b=c']) {
      expect(() => parseLogDirective(invalid)).toThrow();
    }
  });

  it('does not inspect disabled messages and only emits normalized JSON to console', () => {
    const { log } = capture({ level: LogLevel.SILENT });
    const ownKeys = vi.fn(() => {
      throw new Error('must not inspect');
    });
    log.error(new Proxy({}, { ownKeys }));
    expect(ownKeys).not.toHaveBeenCalled();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const app = new ApplicationLogger({ sinks: [consoleLogSink] });
      app.createLogger().log({ token: 'sensitive' });
      expect(consoleSpy).toHaveBeenCalledOnce();
      expect(consoleSpy.mock.calls[0]).toHaveLength(1);
      expect(consoleSpy.mock.calls[0]?.[0]).not.toContain('sensitive');
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe('bounded log serialization', () => {
  it('handles cycles, BigInt, nonfinite numbers and unsupported values without evaluating code', () => {
    const getter = vi.fn(() => 'secret');
    const toJSON = vi.fn(() => 'secret');
    const value = {
      n: NaN,
      b: 2n,
      toJSON,
      get hidden() {
        return getter();
      },
      self: {},
    };
    value.self = value;
    expect(serializeLogValue(value)).toEqual({
      n: 'NaN',
      b: '2n',
      toJSON: '[Function]',
      hidden: '[Accessor]',
      self: '[Circular]',
    });
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(
      serializeLogValue(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error();
            },
          },
        ),
      ),
    ).toBe('[Uninspectable]');
  });

  it('recognizes the data-only Secret marker, and preserves prototype-shaped keys safely', () => {
    const secret = { value: 'hidden' };
    Object.defineProperty(secret, Symbol.for('vela.secret'), { value: true });
    expect(serializeLogValue(secret)).toBe('[Redacted]');
    const value = JSON.parse('{"__proto__":{"polluted":true},"constructor":"value"}');
    const safe = serializeLogValue(value);
    expect(JSON.stringify(safe)).toContain('__proto__');
    expect(Object.getPrototypeOf(safe)).toBe(Object.prototype);
  });

  it('bounds depth, width, total visited nodes, and string size; validates configuration', () => {
    expect(serializeLogValue({ a: { b: { c: 1 } } }, { maxDepth: 2 })).toEqual({
      a: { b: '[MaxDepth]' },
    });
    expect(serializeLogValue([1, 2, 3], { maxEntries: 2 })).toEqual([1, 2, '[Truncated]']);
    expect(serializeLogValue([1, 2, 3], { maxNodes: 2 })).toEqual([1, '[Truncated]']);
    expect(serializeLogValue({ password: 'a', token: 'b' }, { maxNodes: 2 })).toEqual({
      password: '[Redacted]',
      '[Truncated]': true,
    });
    expect(serializeLogValue('abcdef', { maxStringLength: 3 })).toBe('abc[Truncated]');
    expect(() => serializeLogValue({}, { maxDepth: Infinity })).toThrow();
    expect(() => new ApplicationLogger({ maxPending: 0 })).toThrow();
    expect(() => new ApplicationLogger({ categories: { bad: 999 as never } })).toThrow();
  });
});
