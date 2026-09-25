import { describe, it, expect, vi } from 'vitest';
import { Logger, LogLevel } from '../services/logger.js';

describe('Logger — context providers', () => {
  it('instance-level provider appends key=value pairs to the output line', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new Logger('Svc');
    logger.addContextProvider(() => ({ requestId: 'abc-123' }));

    logger.log('hello');

    const line = spy.mock.calls[0]![0] as string;
    expect(line).toContain('hello');
    expect(line).toContain('requestId=abc-123');
    spy.mockRestore();
  });

  it('context providers belong to each logger', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const a = new Logger('A').addContextProvider(() => ({ env: 'test' }));
    const b = new Logger('B');
    a.log('one');
    b.log('two');

    expect(spy.mock.calls[0]![0] as string).toContain('env=test');
    expect(spy.mock.calls[1]![0] as string).not.toContain('env=test');
    spy.mockRestore();
  });

  it('later providers override earlier values', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new Logger('Svc');
    logger.addContextProvider(() => ({ scope: 'global', env: 'prod' }));
    logger.addContextProvider(() => ({ scope: 'instance' }));

    logger.log('msg');

    const line = spy.mock.calls[0]![0] as string;
    expect(line).toContain('scope=instance');
    expect(line).toContain('env=prod');
    expect(line).not.toContain('scope=global');
    spy.mockRestore();
  });

  it('provider that throws does not break logging', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new Logger('Svc');
    logger.addContextProvider(() => {
      throw new Error('boom');
    });
    logger.addContextProvider(() => ({ ok: true }));

    logger.log('still here');

    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]![0] as string;
    expect(line).toContain('still here');
    expect(line).toContain('ok=true');
    spy.mockRestore();
  });

  it('JSON-stringifies values containing spaces or special chars', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new Logger('Svc');
    logger.addContextProvider(() => ({ user: 'Alice Bee', count: 3 }));

    logger.log('msg');

    const line = spy.mock.calls[0]![0] as string;
    expect(line).toContain('user="Alice Bee"');
    expect(line).toContain('count=3');
    spy.mockRestore();
  });

  it('skips undefined/null values', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new Logger('Svc');
    logger.addContextProvider(() => ({ a: 'x', b: undefined, c: null }));

    logger.log('msg');

    const line = spy.mock.calls[0]![0] as string;
    expect(line).toContain('a=x');
    expect(line).not.toContain('b=');
    expect(line).not.toContain('c=');
    spy.mockRestore();
  });
});

describe('Logger — extend()', () => {
  it('returns a child logger with a namespaced context', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const root = new Logger('App');
    const http = root.extend('http');

    http.log('hi');

    const line = spy.mock.calls[0]![0] as string;
    expect(line).toContain('[App:http]');
    spy.mockRestore();
  });

  it('child inherits parent instance context providers', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const root = new Logger('App');
    root.addContextProvider(() => ({ requestId: 'abc' }));

    const child = root.extend('http');
    child.log('msg');

    const line = spy.mock.calls[0]![0] as string;
    expect(line).toContain('requestId=abc');
    spy.mockRestore();
  });

  it('child can add its own providers without polluting the parent', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const root = new Logger('App');
    const child = root.extend('http');
    child.addContextProvider(() => ({ subsystem: 'http' }));

    root.log('from-root');
    child.log('from-child');

    expect(spy.mock.calls[0]![0] as string).not.toContain('subsystem=');
    expect(spy.mock.calls[1]![0] as string).toContain('subsystem=http');
    spy.mockRestore();
  });

  it('extends deeply — context accumulates colon-separated', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const root = new Logger('App');
    const leaf = root.extend('http').extend('auth');

    leaf.log('msg');

    expect(spy.mock.calls[0]![0] as string).toContain('[App:http:auth]');
    spy.mockRestore();
  });

  it('extend on a no-context logger produces a logger whose context is the namespace', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const root = new Logger();
    const child = root.extend('worker');

    child.log('msg');

    expect(spy.mock.calls[0]![0] as string).toContain('[worker]');
    spy.mockRestore();
  });
});

describe('Logger — pluggable writer', () => {
  it('setWriter replaces console output for the instance', () => {
    const lines: Array<{ level: string; line: string }> = [];
    const logger = new Logger('Svc');
    logger.setWriter((level, line) => {
      lines.push({ level, line: line as string });
    });

    logger.log('a');
    logger.warn('b');
    logger.error('c');

    expect(lines).toHaveLength(3);
    expect(lines[0]!.level).toBe('LOG');
    expect(lines[0]!.line).toContain('a');
    expect(lines[1]!.level).toBe('WARN');
    expect(lines[2]!.level).toBe('ERROR');
  });

  it('writers belong to each logger', () => {
    const globalLines: string[] = [];
    const other = new Logger('Other');
    other.setWriter((_level, line) => {
      globalLines.push(line as string);
    });

    const instanceLines: string[] = [];
    const logger = new Logger('Svc');
    logger.setWriter((_level, line) => {
      instanceLines.push(line as string);
    });

    logger.log('custom');
    other.log('global');

    expect(instanceLines).toHaveLength(1);
    expect(instanceLines[0]).toContain('custom');
    expect(globalLines).toHaveLength(1);
    expect(globalLines[0]).toContain('global');
  });

  it('child logger from extend() inherits the writer', () => {
    const lines: string[] = [];
    const root = new Logger('App');
    root.setWriter((_level, line) => {
      lines.push(line as string);
    });

    const child = root.extend('http');
    child.log('inherited');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[App:http]');
    expect(lines[0]).toContain('inherited');
  });

  it('resetWriter restores default console behavior', () => {
    const logger = new Logger('Svc');
    logger.setWriter(() => {
      /* noop */
    });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.log('before-reset');
    expect(spy).not.toHaveBeenCalled();

    logger.resetWriter();
    logger.log('after-reset');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

it('isolates logger levels and snapshots child configuration', () => {
  const first = vi.fn();
  const second = vi.fn();
  const parent = new Logger().setWriter(first).setLogLevel(LogLevel.ERROR);
  const child = parent.extend('child');
  const other = new Logger().setWriter(second);
  parent.setLogLevel(LogLevel.DEBUG);
  child.log('hidden');
  parent.debug('visible');
  other.log('visible');
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
});
