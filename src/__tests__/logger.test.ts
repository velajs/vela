import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Logger, LogLevel } from '../services/logger.js';
import { Container } from '../container/container.js';
import type { LoggerService } from '../services/logger.js';

beforeEach(() => {
  Logger.setLogLevel(LogLevel.LOG);
  Logger.overrideLogger(false);
  // Re-enable after clearing
  (Logger as any)['globalLogger'] = undefined;
});

describe('Logger', () => {
  describe('basic output', () => {
    it('should output log messages with correct format', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const logger = new Logger('TestService');

      logger.log('hello world');

      expect(spy).toHaveBeenCalledTimes(1);
      const msg = spy.mock.calls[0][0] as string;
      expect(msg).toMatch(/\[Vela\] .+ LOG \[TestService\] hello world/);
      spy.mockRestore();
    });

    it('should output error messages', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logger = new Logger('ErrCtx');

      logger.error('something failed');

      expect(spy).toHaveBeenCalledTimes(1);
      const msg = spy.mock.calls[0][0] as string;
      expect(msg).toMatch(/\[Vela\] .+ ERROR \[ErrCtx\] something failed/);
      spy.mockRestore();
    });

    it('should output warn messages', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const logger = new Logger();

      logger.warn('careful');

      expect(spy).toHaveBeenCalledTimes(1);
      const msg = spy.mock.calls[0][0] as string;
      expect(msg).toMatch(/\[Vela\] .+ WARN careful/);
      spy.mockRestore();
    });

    it('should output debug messages when level allows', () => {
      Logger.setLogLevel(LogLevel.DEBUG);
      const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const logger = new Logger('Dbg');

      logger.debug('debug info');

      expect(spy).toHaveBeenCalledTimes(1);
      const msg = spy.mock.calls[0][0] as string;
      expect(msg).toMatch(/\[Vela\] .+ DEBUG \[Dbg\] debug info/);
      spy.mockRestore();
    });

    it('should output verbose messages when level allows', () => {
      Logger.setLogLevel(LogLevel.VERBOSE);
      const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const logger = new Logger('Vbs');

      logger.verbose('verbose info');

      expect(spy).toHaveBeenCalledTimes(1);
      const msg = spy.mock.calls[0][0] as string;
      expect(msg).toMatch(/\[Vela\] .+ VERBOSE \[Vbs\] verbose info/);
      spy.mockRestore();
    });
  });

  describe('log level filtering', () => {
    it('should suppress log when level is WARN', () => {
      Logger.setLogLevel(LogLevel.WARN);
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const logger = new Logger();

      logger.log('should not appear');

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('should suppress debug when level is LOG', () => {
      Logger.setLogLevel(LogLevel.LOG);
      const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const logger = new Logger();

      logger.debug('hidden');

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('should suppress everything in SILENT mode', () => {
      Logger.setLogLevel(LogLevel.SILENT);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const logger = new Logger();

      logger.log('a');
      logger.error('b');
      logger.warn('c');
      logger.debug('d');
      logger.verbose('e');

      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(debugSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      debugSpy.mockRestore();
    });
  });

  describe('overrideLogger', () => {
    it('should delegate to custom logger', () => {
      const calls: string[] = [];
      const custom: LoggerService = {
        log: (msg) => calls.push(`log:${msg}`),
        error: (msg) => calls.push(`error:${msg}`),
        warn: (msg) => calls.push(`warn:${msg}`),
        debug: (msg) => calls.push(`debug:${msg}`),
        verbose: (msg) => calls.push(`verbose:${msg}`),
      };

      Logger.overrideLogger(custom);
      const logger = new Logger('Ctx');

      logger.log('a');
      logger.error('b');
      logger.warn('c');

      expect(calls).toEqual(['log:a', 'error:b', 'warn:c']);
    });

    it('should silence all output when overrideLogger(false)', () => {
      Logger.overrideLogger(false);
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const logger = new Logger();

      logger.log('silenced');

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('setContext', () => {
    it('should change context prefix', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const logger = new Logger('Old');

      logger.setContext('New');
      logger.log('msg');

      const msg = spy.mock.calls[0][0] as string;
      expect(msg).toContain('[New]');
      expect(msg).not.toContain('[Old]');
      spy.mockRestore();
    });
  });

  describe('DI resolution', () => {
    it('should resolve as injectable singleton', () => {
      const container = new Container();
      container.register(Logger);

      const a = container.resolve(Logger);
      const b = container.resolve(Logger);

      expect(a).toBe(b);
      expect(a).toBeInstanceOf(Logger);
    });
  });
});
