import { Injectable } from '../container/decorators';

export const LogLevel = {
  VERBOSE: 0,
  DEBUG: 1,
  LOG: 2,
  WARN: 3,
  ERROR: 4,
  SILENT: 5,
} as const;
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

export interface LoggerService {
  log(message: unknown, ...optionalParams: unknown[]): void;
  error(message: unknown, ...optionalParams: unknown[]): void;
  warn(message: unknown, ...optionalParams: unknown[]): void;
  debug?(message: unknown, ...optionalParams: unknown[]): void;
  verbose?(message: unknown, ...optionalParams: unknown[]): void;
}

export type ContextProvider = () => Record<string, unknown>;

export type LoggerLevelName = 'LOG' | 'ERROR' | 'WARN' | 'DEBUG' | 'VERBOSE';

export type Writer = (level: LoggerLevelName, line: string, ...rest: unknown[]) => void;

const defaultWriter: Writer = (level, line, ...rest) => {
  if (level === 'ERROR') return console.error(line, ...rest);
  if (level === 'WARN') return console.warn(line, ...rest);
  if (level === 'DEBUG' || level === 'VERBOSE') return console.debug(line, ...rest);
  return console.log(line, ...rest);
};

function formatValue(v: unknown): string {
  if (typeof v === 'string') {
    return /[\s="\\]/.test(v) ? JSON.stringify(v) : v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

@Injectable()
export class Logger implements LoggerService {
  static level: LogLevel = LogLevel.LOG;

  private static globalLogger: LoggerService | false | undefined;
  private static globalContextProviders: ContextProvider[] = [];
  private static globalWriter: Writer = defaultWriter;

  private context?: string;
  private instanceContextProviders: ContextProvider[] = [];
  private instanceWriter?: Writer;

  static setLogLevel(level: LogLevel): void {
    Logger.level = level;
  }

  static overrideLogger(logger: LoggerService | false): void {
    Logger.globalLogger = logger;
  }

  /** Register a context provider run on every log line from every logger. */
  static addContextProvider(provider: ContextProvider): void {
    Logger.globalContextProviders.push(provider);
  }

  /** Remove all registered global context providers. */
  static clearContextProviders(): void {
    Logger.globalContextProviders = [];
  }

  /** Replace the default console writer. Useful on edge runtimes that have
   *  a different output sink (e.g. `env.LOGS.writeDataPoint` on Workers). */
  static setWriter(writer: Writer): void {
    Logger.globalWriter = writer;
  }

  /** Restore the default console-based writer. */
  static resetWriter(): void {
    Logger.globalWriter = defaultWriter;
  }

  constructor(context?: string) {
    if (context) {
      this.context = context;
    }
  }

  setContext(context: string): void {
    this.context = context;
  }

  /** Add a context provider that runs only for THIS logger instance.
   *  Children created via extend() inherit these providers by copy. */
  addContextProvider(provider: ContextProvider): this {
    this.instanceContextProviders.push(provider);
    return this;
  }

  /** Override the writer for this logger (and any extend() children). */
  setWriter(writer: Writer): this {
    this.instanceWriter = writer;
    return this;
  }

  /** Create a child logger with a nested namespace. Context becomes
   *  `parent:child`; instance-level providers and writers are inherited
   *  by copy so later mutations on either logger stay isolated. */
  extend(namespace: string): Logger {
    const newContext = this.context ? `${this.context}:${namespace}` : namespace;
    const child = new Logger(newContext);
    child.instanceContextProviders = [...this.instanceContextProviders];
    if (this.instanceWriter) child.instanceWriter = this.instanceWriter;
    return child;
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('LOG', LogLevel.LOG, message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('ERROR', LogLevel.ERROR, message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('WARN', LogLevel.WARN, message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('DEBUG', LogLevel.DEBUG, message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('VERBOSE', LogLevel.VERBOSE, message, optionalParams);
  }

  private emit(
    levelName: LoggerLevelName,
    levelValue: LogLevel,
    message: unknown,
    rest: unknown[],
  ): void {
    if (Logger.level > levelValue) return;
    if (Logger.globalLogger === false) return;

    if (Logger.globalLogger) {
      const method = levelName.toLowerCase() as keyof LoggerService;
      const fn = Logger.globalLogger[method] as
        | ((message: unknown, ...optionalParams: unknown[]) => void)
        | undefined;
      if (fn) fn.call(Logger.globalLogger, message, ...rest);
      return;
    }

    const line = this.formatMessage(levelName, message);
    const writer = this.instanceWriter ?? Logger.globalWriter;
    writer(levelName, line, ...rest);
  }

  private formatMessage(level: string, message: unknown): string {
    const timestamp = new Date().toISOString();
    const ctx = this.context ? ` [${this.context}]` : '';
    const contextStr = this.formatContextObj(this.collectContext());
    return `[Vela] ${timestamp} ${level}${ctx} ${message}${contextStr}`;
  }

  private collectContext(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const provider of Logger.globalContextProviders) {
      try {
        Object.assign(result, provider());
      } catch {
        // Provider threw; drop its contribution and keep going.
      }
    }
    for (const provider of this.instanceContextProviders) {
      try {
        Object.assign(result, provider());
      } catch {
        // Same — never let a provider break logging.
      }
    }
    return result;
  }

  private formatContextObj(obj: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (value === undefined || value === null) continue;
      parts.push(`${key}=${formatValue(value)}`);
    }
    return parts.length > 0 ? ` ${parts.join(' ')}` : '';
  }
}
