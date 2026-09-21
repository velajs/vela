/** JSON values owned by a diagnostic snapshot, never live application objects. */
type SnapshotValue =
  | null
  | boolean
  | number
  | string
  | SnapshotValue[]
  | { [key: string]: SnapshotValue };

const MAX_DEPTH = 8;
const MAX_ITEMS = 64;
const MAX_NODES = 256;
const MAX_STRING = 2_048;
const MAX_TEXT = 16_384;
const TRUNCATED = '[truncated]';

/**
 * Bounded projection for diagnostics only (not an application data serializer).
 * Plain records and arrays are copied through own data descriptors. Accessors,
 * functions and instances become markers; no getter, toJSON or instance field
 * is inspected. Ancestors detect cycles without mislabeling repeated references.
 * A throwing proxy becomes an unavailable marker. Bounds apply to the resulting
 * snapshot; reflection on an arbitrary Proxy can still execute its traps.
 */
export function diagnosticSnapshot(input: unknown): SnapshotValue {
  const ancestors = new WeakSet<object>();
  let nodes = MAX_NODES;
  let text = MAX_TEXT;

  function string(value: string): string {
    const length = Math.min(MAX_STRING, text);
    const clipped = value.slice(0, length);
    text -= clipped.length;
    return value.length > length ? `${clipped}${TRUNCATED}` : clipped;
  }

  function visit(value: unknown, depth: number): SnapshotValue {
    if (nodes-- <= 0) return TRUNCATED;
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return string(value);
    if (typeof value === 'number') return Number.isFinite(value) ? value : `[${value}]`;
    if (typeof value === 'bigint') return string(`${value}n`);
    if (typeof value !== 'object') return `[${typeof value}]`;
    if (ancestors.has(value)) return '[circular]';
    if (depth >= MAX_DEPTH) return TRUNCATED;

    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
        if (typeof length !== 'number') return '[unavailable]';
        const out: SnapshotValue[] = [];
        for (let i = 0; i < Math.min(length, MAX_ITEMS); i++) {
          if (nodes <= 0) {
            out.push(TRUNCATED);
            return out;
          }
          const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
          out.push(
            descriptor === undefined
              ? visit(null, depth + 1)
              : 'value' in descriptor
                ? visit(descriptor.value, depth + 1)
                : visit('[accessor]', depth + 1),
          );
        }
        if (length > MAX_ITEMS) out.push(TRUNCATED);
        return out;
      }
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== null && prototype !== Object.prototype) return '[instance]';
      const out: { [key: string]: SnapshotValue } = {};
      let count = 0;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (count++ >= MAX_ITEMS || nodes <= 0 || text <= 0) {
          Object.defineProperty(out, '$studio.truncated', { value: true, enumerable: true });
          break;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined) continue;
        Object.defineProperty(out, string(key), {
          value:
            'value' in descriptor
              ? visit(descriptor.value, depth + 1)
              : visit('[accessor]', depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return out;
    } catch {
      return '[unavailable]';
    } finally {
      ancestors.delete(value);
    }
  }

  return visit(input, 0);
}
