import { Injectable } from '../container/decorators';

export enum LogLevel {
  VERBOSE = 0,
  DEBUG = 1,
  LOG = 2,
  WARN = 3,
  ERROR = 4,
  SILENT = 5,
}

export interface LoggerService {
  log(message: unknown, ...optionalParams: unknown[]): void;
  error(message: unknown, ...optionalParams: unknown[]): void;
  warn(message: unknown, ...optionalParams: unknown[]): void;
  debug?(message: unknown, ...optionalParams: unknown[]): void;
  verbose?(message: unknown, ...optionalParams: unknown[]): void;
}

@Injectable()
export class Logger implements LoggerService {
  static level: LogLevel = LogLevel.LOG;

  private static globalLogger: LoggerService | false | undefined;

  private context?: string;

  static setLogLevel(level: LogLevel): void {
    Logger.level = level;
  }

  static overrideLogger(logger: LoggerService | false): void {
    Logger.globalLogger = logger;
  }

  constructor(context?: string) {
    if (context) {
      this.context = context;
    }
  }

  setContext(context: string): void {
    this.context = context;
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    if (Logger.level > LogLevel.LOG) return;
    if (Logger.globalLogger === false) return;
    if (Logger.globalLogger) {
      Logger.globalLogger.log(message, ...optionalParams);
      return;
    }
    console.log(this.formatMessage('LOG', message), ...optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    if (Logger.level > LogLevel.ERROR) return;
    if (Logger.globalLogger === false) return;
    if (Logger.globalLogger) {
      Logger.globalLogger.error(message, ...optionalParams);
      return;
    }
    console.error(this.formatMessage('ERROR', message), ...optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    if (Logger.level > LogLevel.WARN) return;
    if (Logger.globalLogger === false) return;
    if (Logger.globalLogger) {
      Logger.globalLogger.warn(message, ...optionalParams);
      return;
    }
    console.warn(this.formatMessage('WARN', message), ...optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    if (Logger.level > LogLevel.DEBUG) return;
    if (Logger.globalLogger === false) return;
    if (Logger.globalLogger) {
      Logger.globalLogger.debug?.(message, ...optionalParams);
      return;
    }
    console.debug(this.formatMessage('DEBUG', message), ...optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    if (Logger.level > LogLevel.VERBOSE) return;
    if (Logger.globalLogger === false) return;
    if (Logger.globalLogger) {
      Logger.globalLogger.verbose?.(message, ...optionalParams);
      return;
    }
    console.debug(this.formatMessage('VERBOSE', message), ...optionalParams);
  }

  private formatMessage(level: string, message: unknown): string {
    const timestamp = new Date().toISOString();
    const ctx = this.context ? ` [${this.context}]` : '';
    return `[Vela] ${timestamp} ${level}${ctx} ${message}`;
  }
}
