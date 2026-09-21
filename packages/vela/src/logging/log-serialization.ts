import type { LogSerializationOptions, LogValue } from './log.types';

const REDACTED = '[Redacted]';
const SECRET = Symbol.for('vela.secret');
const DEFAULT_REDACT_KEYS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'password',
  'passwd',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'credentials',
];

export interface LogSerializer {
  serialize(value: unknown): LogValue;
  text(value: string): string;
}

function limit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new TypeError(`Log serialization limits must be integers between 1 and ${maximum}.`);
  }
  return result;
}

/** Options are validated and copied once. Each serialization gets an independent node budget. */
export function createLogSerializer(options: LogSerializationOptions = {}): LogSerializer {
  const maxDepth = limit(options.maxDepth, 6, 32);
  const maxEntries = limit(options.maxEntries, 32, 1024);
  const maxNodes = limit(options.maxNodes, 512, 10000);
  const maxStringLength = limit(options.maxStringLength, 2048, 65536);
  const redact = new Set(DEFAULT_REDACT_KEYS.map((key) => key.toLowerCase()));
  for (const key of options.redactKeys ?? []) {
    if (typeof key !== 'string' || !key.length) throw new TypeError('Invalid log redaction key.');
    redact.add(key.toLowerCase());
  }
  const text = (value: string): string =>
    value.length <= maxStringLength ? value : `${value.slice(0, maxStringLength)}[Truncated]`;

  return {
    text,
    serialize(value) {
      let nodes = 0;
      const ancestors = new WeakSet<object>();
      function visit(input: unknown, depth: number): LogValue {
        if (++nodes > maxNodes) return '[Truncated]';
        if (input === null) return null;
        if (typeof input === 'string') return text(input);
        if (typeof input === 'boolean') return input;
        if (typeof input === 'number') return Number.isFinite(input) ? input : String(input);
        if (typeof input === 'bigint') return text(`${input}n`);
        if (typeof input === 'undefined') return '[Undefined]';
        if (typeof input === 'symbol') return '[Symbol]';
        if (typeof input === 'function') return '[Function]';
        if (ancestors.has(input)) return '[Circular]';
        if (depth >= maxDepth) return '[MaxDepth]';
        ancestors.add(input);
        try {
          if (Object.getOwnPropertyDescriptor(input, SECRET)?.value === true) return REDACTED;
          if (Array.isArray(input)) {
            const result: LogValue[] = [];
            const length: unknown = Object.getOwnPropertyDescriptor(input, 'length')?.value;
            if (typeof length !== 'number') return '[Uninspectable]';
            for (let i = 0; i < Math.min(length, maxEntries); i++) {
              if (nodes >= maxNodes) {
                result.push('[Truncated]');
                break;
              }
              result.push(property(input, String(i), depth));
            }
            if (length > maxEntries) result.push('[Truncated]');
            return Object.freeze(result);
          }
          const result: Record<string, LogValue> = {};
          let count = 0;
          if (input instanceof Error) {
            // Data descriptors avoid arbitrary getters (including runtime accessor stacks).
            for (const key of ['name', 'message', 'stack', 'cause']) {
              const descriptor = Object.getOwnPropertyDescriptor(input, key);
              if (descriptor)
                Object.defineProperty(result, key, {
                  value: property(input, key, depth),
                  enumerable: true,
                });
            }
            if (!Object.hasOwn(result, 'name')) {
              Object.defineProperty(result, 'name', { value: 'Error', enumerable: true });
            }
          }
          for (const key in input) {
            if (!Object.hasOwn(input, key) || Object.hasOwn(result, key)) continue;
            if (count++ >= maxEntries || nodes >= maxNodes) {
              Object.defineProperty(result, '[Truncated]', { value: true, enumerable: true });
              break;
            }
            // Do not truncate property names into collisions or prototype setters.
            if (key.length > maxStringLength) continue;
            Object.defineProperty(result, key, {
              value: property(input, key, depth),
              enumerable: true,
            });
          }
          return Object.freeze(result);
        } catch {
          return '[Uninspectable]';
        } finally {
          ancestors.delete(input);
        }
      }
      function property(owner: object, key: string, depth: number): LogValue {
        if (redact.has(key.toLowerCase())) return REDACTED;
        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
        if (!descriptor) return '[Undefined]';
        return 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[Accessor]';
      }
      return visit(value, 0);
    },
  };
}

/** Safe diagnostic projection; does not invoke toJSON, toString, or accessor properties. */
export function serializeLogValue(value: unknown, options?: LogSerializationOptions): LogValue {
  return createLogSerializer(options).serialize(value);
}
