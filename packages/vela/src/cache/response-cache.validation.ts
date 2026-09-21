import type {
  ResponseCacheEntryOptions,
  ResponseCacheOptions,
  ResponseCacheScope,
} from './response-cache.types';

export function validateLabel(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2048 ||
    new TextEncoder().encode(value).length > 2048
  ) {
    throw new TypeError(`${name} must be a nonempty string of at most 2048 UTF-8 bytes.`);
  }
}

export function validateTtl(ttl: number): void {
  if (!Number.isFinite(ttl) || ttl < 0 || ttl > 86400 * 365)
    throw new TypeError('Cache TTL must be between zero and one year in seconds.');
}

export function validateScope(scope: ResponseCacheScope): void {
  if (!scope || (scope.visibility !== 'public' && scope.visibility !== 'private'))
    throw new TypeError('An explicit public/private cache scope is required.');
  validateLabel(scope.partition, 'Cache partition');
}

export function validateEntryOptions(options: ResponseCacheEntryOptions): void {
  if (options.ttl !== undefined) validateTtl(options.ttl);
  if (options.tags !== undefined) {
    if (!Array.isArray(options.tags) || options.tags.length > 32)
      throw new TypeError('Cache tags must be an array of at most 32 labels.');
    for (const tag of options.tags) validateLabel(tag, 'Cache tag');
  }
}

export function validateOptions(options: ResponseCacheOptions): void {
  validateLabel(options.namespace, 'Cache namespace');
  validateTtl(options.ttl ?? 30);
  if (
    !Number.isInteger(options.maxBytes ?? 65536) ||
    (options.maxBytes ?? 65536) < 1 ||
    (options.maxBytes ?? 65536) > 1048576
  )
    throw new TypeError('maxBytes must be between 1 and 1048576.');
  if (typeof options.scope !== 'function')
    throw new TypeError('Response caching requires a trusted scope resolver.');
  for (const method of ['get', 'set', 'del', 'clear'] as const) {
    if (typeof options.store?.[method] !== 'function')
      throw new TypeError(`Cache store requires ${method}().`);
  }
  if (
    options.invalidation !== undefined &&
    (!options.invalidation ||
      typeof options.invalidation.getVersion !== 'function' ||
      typeof options.invalidation.invalidate !== 'function')
  )
    throw new TypeError('Invalid cache invalidation store.');
  if (options.shouldCache !== undefined && typeof options.shouldCache !== 'function')
    throw new TypeError('shouldCache must be a function.');
  if (options.onError !== undefined && typeof options.onError !== 'function')
    throw new TypeError('onError must be a function.');
}

// Defense in depth; applications must still exclude secrets under arbitrary domain names.
const sensitive =
  /^(?:authorization|proxyauthorization|cookie|setcookie|password|passwordhash|secret|clientsecret|accesstoken|refreshtoken|idtoken|apikey|privatekey|sessiontoken)$/i;

/** Bounded JSON snapshot, without invoking getters, toJSON, or arbitrary class methods. */
export function snapshot(value: unknown, maxBytes: number): string | undefined {
  let nodes = 0;
  let budget = maxBytes;
  const parents = new WeakSet<object>();
  function visit(input: unknown, depth: number): boolean {
    if (++nodes > 10000 || depth > 32 || budget < 0) return false;
    if (input === null || typeof input === 'boolean') {
      budget -= input === null ? 4 : input ? 4 : 5;
      return true;
    }
    if (typeof input === 'number') {
      budget -= String(input).length;
      return Number.isFinite(input);
    }
    if (typeof input === 'string') {
      if (input.length > budget) return false;
      budget -= new TextEncoder().encode(input).length;
      return budget >= 0;
    }
    if (typeof input !== 'object' || parents.has(input)) return false;
    if (Array.isArray(input) && Object.getPrototypeOf(input) !== Array.prototype) return false;
    if (
      !Array.isArray(input) &&
      Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null
    )
      return false;
    if ((Array.isArray(input) && input.length > 10000) || Reflect.ownKeys(input).length > 10000)
      return false;
    parents.add(input);
    for (const key of Reflect.ownKeys(input)) {
      if (Array.isArray(input) && key === 'length') continue;
      if (typeof key !== 'string' || sensitive.test(key.replace(/[-_]/g, ''))) return false;
      const property = Object.getOwnPropertyDescriptor(input, key)!;
      if (!('value' in property) || !property.enumerable || !visit(property.value, depth + 1))
        return false;
      budget -= new TextEncoder().encode(key).length;
    }
    parents.delete(input);
    return budget >= 0;
  }
  try {
    if (!visit(value, 0)) return undefined;
    const json = JSON.stringify(value);
    return json !== undefined && new TextEncoder().encode(json).length <= maxBytes
      ? json
      : undefined;
  } catch {
    return undefined;
  }
}
