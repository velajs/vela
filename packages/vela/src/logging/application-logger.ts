import { LogLevel, type LoggerLevelName, type LoggerService } from '../services/logger';
import { createLogSerializer, type LogSerializer } from './log-serialization';
import { checkedLogLevel, parseLogDirective, type LogThresholds } from './log-levels';
import type {
  ApplicationLoggerOptions,
  LogDeliveryContext,
  LogFields,
  LogRecord,
  LogSink,
  LogValue,
} from './log.types';

function isFields(value: LogValue): value is Readonly<Record<string, LogValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValues(value: LogValue): value is readonly LogValue[] {
  return Array.isArray(value);
}

/** JSON is formatted only after normalization/redaction, including all additional arguments. */
/* oxlint-disable no-console -- The explicit console sink is the selected log transport. */
export const consoleLogSink: LogSink = (record) => {
  const line = JSON.stringify(record);
  if (record.level === 'ERROR') console.error(line);
  else if (record.level === 'WARN') console.warn(line);
  else if (record.level === 'DEBUG' || record.level === 'VERBOSE') console.debug(line);
  else console.log(line);
};

/* oxlint-enable no-console */

type Emit = (
  category: string,
  fields: LogFields,
  delivery: LogDeliveryContext,
  level: LoggerLevelName,
  message: unknown,
  rest: readonly unknown[],
) => void;

/** Explicitly bound context. Creating a child never changes another logger's fields. */
export class StructuredLogger implements LoggerService {
  readonly #category: string;
  readonly #fields: LogFields;
  readonly #delivery: LogDeliveryContext;
  readonly #emit: Emit;
  readonly #enabled: (level: LogLevel, category: string) => boolean;
  readonly #snapshot: (fields: LogFields) => LogFields;

  /** @internal Construct through ApplicationLogger.createLogger(). */
  constructor(
    category: string,
    fields: LogFields,
    delivery: LogDeliveryContext,
    emit: Emit,
    enabled: (level: LogLevel, category: string) => boolean,
    snapshot: (fields: LogFields) => LogFields,
  ) {
    this.#category = category;
    this.#fields = snapshot(fields);
    this.#delivery = delivery;
    this.#emit = emit;
    this.#enabled = enabled;
    this.#snapshot = snapshot;
  }

  isEnabled(level: LogLevel): boolean {
    return this.#enabled(level, this.#category);
  }
  withFields(fields: LogFields): StructuredLogger {
    return new StructuredLogger(
      this.#category,
      { ...this.#fields, ...this.#snapshot(fields) },
      this.#delivery,
      this.#emit,
      this.#enabled,
      this.#snapshot,
    );
  }
  extend(namespace: string): StructuredLogger {
    return new StructuredLogger(
      `${this.#category}:${namespace}`,
      this.#fields,
      this.#delivery,
      this.#emit,
      this.#enabled,
      this.#snapshot,
    );
  }
  log(message: unknown, ...rest: unknown[]): void {
    this.#emit(this.#category, this.#fields, this.#delivery, 'LOG', message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.#emit(this.#category, this.#fields, this.#delivery, 'ERROR', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.#emit(this.#category, this.#fields, this.#delivery, 'WARN', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.#emit(this.#category, this.#fields, this.#delivery, 'DEBUG', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.#emit(this.#category, this.#fields, this.#delivery, 'VERBOSE', message, rest);
  }
}

/** One application's logging state. Independent of legacy Logger's static configuration. */
export class ApplicationLogger {
  readonly #serializer: LogSerializer;
  readonly #sinks: ReadonlySet<LogSink>;
  readonly #subscribers = new Set<LogSink>();
  readonly #pending = new Set<Promise<void>>();
  readonly #maxPending: number;
  #thresholds: LogThresholds;
  #closed = false;
  #emitting = false;
  #dropped = 0;
  #failed = 0;

  constructor(options: ApplicationLoggerOptions = {}) {
    this.#serializer = createLogSerializer(options);
    this.#thresholds = parseLogDirective(options.directive ?? '', options);
    this.#sinks = new Set(options.sinks ?? [consoleLogSink]);
    for (const sink of this.#sinks) {
      if (typeof sink !== 'function') throw new TypeError('Log sinks must be functions.');
    }
    this.#maxPending = options.maxPending ?? 1024;
    if (!Number.isSafeInteger(this.#maxPending) || this.#maxPending < 1) {
      throw new TypeError('maxPending must be a positive safe integer.');
    }
  }

  get diagnostics(): Readonly<{ pending: number; dropped: number; failed: number }> {
    return Object.freeze({
      pending: this.#pending.size,
      dropped: this.#dropped,
      failed: this.#failed,
    });
  }

  /** Invalid directives leave current configuration unchanged. */
  configure(directive: string): void {
    this.#thresholds = parseLogDirective(directive, {
      level: this.#thresholds.level,
      categories: Object.fromEntries(this.#thresholds.categories),
    });
  }

  isEnabled(level: LogLevel, category = 'app'): boolean {
    return (
      !this.#closed &&
      checkedLogLevel(level) >=
        (this.#thresholds.categories.get(category) ?? this.#thresholds.level)
    );
  }

  createLogger(
    category = 'app',
    fields: LogFields = {},
    delivery: LogDeliveryContext = {},
  ): StructuredLogger {
    const context: LogDeliveryContext = {
      fields: this.#snapshot(delivery.fields ?? {}),
      waitUntil: delivery.waitUntil,
    };
    return new StructuredLogger(
      this.#serializer.text(category),
      fields,
      context,
      this.#emit,
      (level, name) => this.isEnabled(level, name),
      this.#snapshot,
    );
  }

  /** Observer delivery is deduplicated by function identity, including configured sinks. */
  subscribe(sink: LogSink): () => void {
    if (typeof sink !== 'function') throw new TypeError('Log sinks must be functions.');
    if (this.#closed) throw new Error('Application logger is disposed.');
    this.#subscribers.add(sink);
    return () => {
      this.#subscribers.delete(sink);
    };
  }

  /** Wait for the deliveries pending at this call; sink failures are already contained. */
  async flush(): Promise<void> {
    await Promise.all(this.#pending);
  }

  async dispose(): Promise<void> {
    this.#closed = true;
    this.#subscribers.clear();
    await this.flush();
  }

  async onModuleDestroy(): Promise<void> {
    await this.dispose();
  }

  readonly #snapshot = (fields: LogFields): Readonly<Record<string, LogValue>> => {
    const value = this.#serializer.serialize(fields);
    return isFields(value) ? value : Object.freeze({ '[fields]': value });
  };

  readonly #emit: Emit = (category, fields, delivery, level, message, rest) => {
    if (!this.isEnabled(LogLevel[level], category)) return;
    if (this.#emitting) {
      this.#dropped++;
      return;
    }
    this.#emitting = true;
    try {
      const first = this.#serializer.serialize(message);
      const args = this.#serializer.serialize(
        typeof message === 'string' ? rest : [message, ...rest],
      );
      const record: LogRecord = Object.freeze({
        timestamp: Date.now(),
        level,
        category,
        message:
          typeof first === 'string'
            ? first
            : isFields(first) && typeof first.message === 'string'
              ? first.message
              : this.#serializer.text(JSON.stringify(first)),
        fields: Object.freeze({
          ...this.#snapshot(fields),
          ...this.#snapshot(delivery.fields ?? {}),
        }),
        arguments: isValues(args) ? args : Object.freeze([args]),
      });
      for (const sink of new Set([...this.#sinks, ...this.#subscribers])) {
        this.#deliver(sink, record, delivery.waitUntil);
      }
    } catch {
      // Never fall back to logging the raw input when normalization fails.
      this.#failed++;
    } finally {
      this.#emitting = false;
    }
  };

  #deliver(sink: LogSink, record: LogRecord, waitUntil: LogDeliveryContext['waitUntil']): void {
    if (this.#pending.size >= this.#maxPending) {
      this.#dropped++;
      return;
    }
    try {
      const result = sink(record);
      if (result === undefined) return;
      const tracked = Promise.resolve(result).catch(() => {
        this.#failed++;
      });
      this.#pending.add(tracked);
      void tracked.then(() => this.#pending.delete(tracked));
      try {
        waitUntil?.(tracked);
      } catch {
        /* Explicit flush still owns the delivery. */
      }
    } catch {
      this.#failed++;
    }
  }
}
