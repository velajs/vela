import { LogLevel } from '../services/logger';

export interface LogThresholds {
  readonly level: LogLevel;
  readonly categories: ReadonlyMap<string, LogLevel>;
}

const NAMES = new Map<string, LogLevel>([
  ['verbose', LogLevel.VERBOSE],
  ['debug', LogLevel.DEBUG],
  ['log', LogLevel.LOG],
  ['info', LogLevel.LOG],
  ['warn', LogLevel.WARN],
  ['error', LogLevel.ERROR],
  ['silent', LogLevel.SILENT],
  ['off', LogLevel.SILENT],
]);

export function checkedLogLevel(value: unknown): LogLevel {
  switch (value) {
    case LogLevel.VERBOSE:
    case LogLevel.DEBUG:
    case LogLevel.LOG:
    case LogLevel.WARN:
    case LogLevel.ERROR:
    case LogLevel.SILENT:
      return value;
    default:
      throw new TypeError('Invalid log level.');
  }
}

/** Parse into new state before applying anything; inherited object names are never levels. */
export function parseLogDirective(
  directive: string,
  defaults: {
    readonly level?: LogLevel;
    readonly categories?: Readonly<Record<string, LogLevel>>;
  } = {},
): LogThresholds {
  if (typeof directive !== 'string') throw new TypeError('Log directive must be a string.');
  let level = checkedLogLevel(defaults.level ?? LogLevel.LOG);
  const categories = new Map<string, LogLevel>();
  for (const [category, value] of Object.entries(defaults.categories ?? {})) {
    if (!category.trim()) throw new TypeError('Log category cannot be empty.');
    categories.set(category, checkedLogLevel(value));
  }
  for (const entry of directive.split(',')) {
    if (!entry.trim()) continue;
    const parts = entry.split('=');
    if (parts.length > 2) throw new TypeError('Expected level or category=level.');
    const category = parts.length === 2 ? parts[0]!.trim() : undefined;
    if (category === '') throw new TypeError('Log category cannot be empty.');
    const name = parts[parts.length - 1]!.trim().toLowerCase();
    const parsed = NAMES.get(name);
    if (parsed === undefined) throw new TypeError(`Unknown log level '${name}'.`);
    if (category === undefined) level = parsed;
    else categories.set(category, parsed);
  }
  return { level, categories };
}
