// With a 10k refresh fan-out, even flush-local keys need a tight aggregate
// memory ceiling in Worker isolates. Larger args simply execute independently.
const MAX_CANONICAL_ARGS_BYTES = 4 * 1024;

/** Publicly documented bound for a `LiveQueryOptions.coalesceBy` partition. */
const MAX_COALESCE_PARTITION_BYTES = 256;

const textEncoder = new TextEncoder();

function isPlainDataProperty(descriptor: PropertyDescriptor | undefined): boolean {
  return (
    descriptor !== undefined &&
    'value' in descriptor &&
    descriptor.enumerable === true &&
    descriptor.configurable === true &&
    descriptor.writable === true
  );
}

/**
 * Canonicalize the JSON-shaped value a live subscription captured as args.
 * Exotic objects, accessors, aliases/cycles, and oversized values fail closed:
 * that subscription simply executes independently for the pass.
 */
function canonicalArgs(value: unknown): string | undefined {
  const seen = new WeakSet<object>();

  const visit = (candidate: unknown): string | undefined => {
    if (candidate === undefined) return 'u';
    if (candidate === null) return 'l';

    switch (typeof candidate) {
      case 'string':
        return `s${JSON.stringify(candidate)}`;
      case 'boolean':
        return candidate ? 'b1' : 'b0';
      case 'number':
        if (Number.isNaN(candidate)) return 'nNaN';
        if (candidate === Number.POSITIVE_INFINITY) return 'n+Infinity';
        if (candidate === Number.NEGATIVE_INFINITY) return 'n-Infinity';
        if (Object.is(candidate, -0)) return 'n-0';
        return `n${String(candidate)}`;
      case 'bigint':
        return `i${String(candidate)}`;
      case 'function':
      case 'symbol':
        return undefined;
      case 'object':
        break;
    }

    if (seen.has(candidate)) return undefined;
    seen.add(candidate);

    if (Array.isArray(candidate)) {
      if (candidate.length > 10_000) return undefined;
      const ownKeys = Reflect.ownKeys(candidate);
      const lengthDescriptor = Object.getOwnPropertyDescriptor(candidate, 'length');
      if (
        lengthDescriptor?.writable !== true ||
        ownKeys.some(
          (key) =>
            typeof key !== 'string' ||
            (key !== 'length' &&
              (!/^(0|[1-9]\d*)$/.test(key) ||
                !Number.isSafeInteger(Number(key)) ||
                Number(key) >= candidate.length)),
        )
      ) {
        return undefined;
      }

      const parts: string[] = [];
      for (let index = 0; index < candidate.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
        if (descriptor === undefined) {
          parts.push('h');
          continue;
        }
        if (!isPlainDataProperty(descriptor)) return undefined;
        const part = visit(descriptor!.value);
        if (part === undefined) return undefined;
        parts.push(part);
      }
      return `a[${parts.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) return undefined;

    const ownKeys = Reflect.ownKeys(candidate);
    if (ownKeys.length > 10_000 || ownKeys.some((key) => typeof key !== 'string')) {
      return undefined;
    }

    const parts: string[] = [];
    for (const key of (ownKeys as string[]).toSorted()) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (!isPlainDataProperty(descriptor)) return undefined;
      const part = visit(descriptor!.value);
      if (part === undefined) return undefined;
      parts.push(`${JSON.stringify(key)}:${part}`);
    }
    return `${prototype === null ? 'z' : 'o'}{${parts.join(',')}}`;
  };

  try {
    const canonical = visit(value);
    if (
      canonical === undefined ||
      textEncoder.encode(canonical).byteLength > MAX_CANONICAL_ARGS_BYTES
    ) {
      return undefined;
    }
    return canonical;
  } catch {
    // Proxies and hostile parsed values can throw from reflection. Sharing is
    // optional, so the safe response is an independent resolver execution.
    return undefined;
  }
}

/** Build a collision-free, flush-local cache key, or opt out safely. */
export function liveCoalescingKey(
  query: string,
  args: unknown,
  partition: string,
): string | undefined {
  if (
    partition.length === 0 ||
    textEncoder.encode(partition).byteLength > MAX_COALESCE_PARTITION_BYTES ||
    [...partition].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    return undefined;
  }

  const canonical = canonicalArgs(args);
  if (canonical === undefined) return undefined;

  // JSON tuple encoding prevents delimiter collisions. Query is first on
  // purpose: no two registered resolvers can share a cache entry.
  return JSON.stringify([query, canonical, partition]);
}
