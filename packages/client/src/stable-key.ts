/** Bounded canonical JSON for cache/dedup keys. */
const MAX_KEY_BYTES = 32 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 10_000;
const MAX_PROPERTY_NAME = 1024;

export function stableStringify(value: unknown): string {
  const budget = { nodes: 0 };
  const encoded = encode(value, 0, new Set<object>(), budget);
  if (new TextEncoder().encode(encoded).byteLength > MAX_KEY_BYTES) {
    throw new TypeError(`stable key exceeds ${MAX_KEY_BYTES} bytes`);
  }
  return encoded;
}

const encode = (
  value: unknown,
  depth: number,
  seen: Set<object>,
  budget: { nodes: number },
): string => {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES || depth > MAX_DEPTH) {
    throw new TypeError('stable key exceeds structural limits');
  }
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('stable key numbers must be finite');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== 'object') throw new TypeError('stable key must be JSON data');
  if (seen.has(value)) throw new TypeError('stable key must not contain cycles');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index))
          throw new TypeError('stable key arrays must not be sparse');
        items.push(encode(value[index], depth + 1, seen, budget));
      }
      return `[${items.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('stable key objects must be plain records');
    }
    const fields: string[] = [];
    for (const key of Object.keys(value).sort()) {
      if (key.length > MAX_PROPERTY_NAME)
        throw new TypeError('stable key property name is too long');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('stable key accessors are not supported');
      }
      fields.push(`${JSON.stringify(key)}:${encode(descriptor.value, depth + 1, seen, budget)}`);
    }
    return `{${fields.join(',')}}`;
  } finally {
    seen.delete(value);
  }
};
