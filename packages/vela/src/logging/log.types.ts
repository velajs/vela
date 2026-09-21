import type { LoggerLevelName, LogLevel } from '../services/logger';

export type LogValue =
  | null
  | boolean
  | number
  | string
  | readonly LogValue[]
  | { readonly [key: string]: LogValue };

/** Immutable, bounded, redacted data. No original application values reach a sink. */
export interface LogRecord {
  readonly timestamp: number;
  readonly level: LoggerLevelName;
  readonly category: string;
  readonly message: string;
  readonly fields: Readonly<Record<string, LogValue>>;
  /** Includes the original first argument when it was not a string (including Errors). */
  readonly arguments: readonly LogValue[];
}

export type LogSink = (record: LogRecord) => void | Promise<void>;
export type LogFields = Readonly<Record<string, unknown>>;

export interface LogSerializationOptions {
  /** Defaults to 6; maximum 32. */
  readonly maxDepth?: number;
  /** Per object/array; defaults to 32, maximum 1024. */
  readonly maxEntries?: number;
  /** Per serialized value; defaults to 512, maximum 10000. */
  readonly maxNodes?: number;
  /** Per string/key; defaults to 2048, maximum 65536. */
  readonly maxStringLength?: number;
  /** Case-insensitive keys redacted at every depth, in addition to the defaults. */
  readonly redactKeys?: readonly string[];
}

export interface ApplicationLoggerOptions extends LogSerializationOptions {
  readonly level?: LogLevel;
  readonly categories?: Readonly<Record<string, LogLevel>>;
  /** Validated atomically; accepts e.g. "warn,http=debug". Overrides level/categories. */
  readonly directive?: string;
  /** Defaults to a JSON console sink. An empty list enables subscription-only capture. */
  readonly sinks?: readonly LogSink[];
  /** Maximum unfinished sink deliveries. New deliveries are dropped at capacity. Default 1024. */
  readonly maxPending?: number;
}

/** Bind sink delivery to an invocation lifetime without introducing ambient state. */
export interface LogDeliveryContext {
  readonly fields?: LogFields;
  readonly waitUntil?: (promise: Promise<void>) => void;
}
