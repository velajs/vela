import { defineProvider } from '../container/types';
import { describe, it, expect, vi } from 'vitest';
import { Logger, LogLevel } from '../services/logger.js';
import { Container } from '../container/container.js';

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
      const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const logger = new Logger('Dbg');
      logger.setLogLevel(LogLevel.DEBUG);

      logger.debug('debug info');

      expect(spy).toHaveBeenCalledTimes(1);
      const msg = spy.mock.calls[0][0] as string;
      expect(msg).toMatch(/\[Vela\] .+ DEBUG \[Dbg\] debug info/);
      spy.mockRestore();
    });

    it('should output verbose messages when level allows', () => {
      const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const logger = new Logger('Vbs');
      logger.setLogLevel(LogLevel.VERBOSE);

      logger.verbose('verbose info');

      expect(spy).toHaveBeenCalledTimes(1);
      const msg = spy.mock.calls[0][0] as string;
      expect(msg).toMatch(/\[Vela\] .+ VERBOSE \[Vbs\] verbose info/);
      spy.mockRestore();
    });
  });

  describe('log level filtering', () => {
    it('should suppress log when level is WARN', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const logger = new Logger();
      logger.setLogLevel(LogLevel.WARN);

      logger.log('should not appear');

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('should suppress debug when level is LOG', () => {
      const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const logger = new Logger();
      logger.setLogLevel(LogLevel.LOG);

      logger.debug('hidden');

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('should suppress everything in SILENT mode', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const logger = new Logger();
      logger.setLogLevel(LogLevel.SILENT);

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
      // Logger has an optional `context?: string` param that isn't a DI
      // token — register via factory so constructor injection is bypassed.
      container.register(defineProvider(Logger, { inject: [], useFactory: () => new Logger() }));

      const a = container.resolve(Logger);
      const b = container.resolve(Logger);

      expect(a).toBe(b);
      expect(a).toBeInstanceOf(Logger);
    });
  });
});
