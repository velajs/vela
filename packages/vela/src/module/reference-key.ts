// Weak: an id never keeps its object alive, and nothing is retained for
// strings or numbers. One table serves every module, so a value keys the same
// way wherever it is passed.
const referenceIds = new WeakMap<WeakKey, number>();
let nextReferenceId = 0;

function reference(value: WeakKey): string {
  let id = referenceIds.get(value);
  if (id === undefined) {
    id = ++nextReferenceId;
    referenceIds.set(value, id);
  }
  return `ref:${id}`;
}

function part(value: unknown): string {
  if (typeof value === 'object' && value !== null) return reference(value);
  if (typeof value === 'function') return reference(value);
  if (typeof value === 'symbol') {
    // A registered symbol is a value (and cannot be a weak key).
    const registered = Symbol.keyFor(value);
    return registered === undefined ? reference(value) : `symbol:${registered}`;
  }
  return value === undefined ? 'undefined' : `${typeof value}:${String(value)}`;
}

/**
 * An instance key over stateful values, for a `defineModule` `key` or a
 * hand-written `DynamicModule.key`. Objects, functions and symbols key by
 * reference, so a driver, client or closure is its own instance even when
 * another has the same shape or source; strings, numbers and booleans key by
 * value. Never pass a secret: keys appear in module ids and diagnostics.
 *
 * ```ts
 * defineModule<ClientOptions, 'client'>({
 *   name: 'Client',
 *   structural: ['client'],
 *   key: (options) => referenceKey(options.client),
 * });
 * ```
 */
export function referenceKey(...values: readonly unknown[]): string {
  // Exact rather than hashed: two different references never share a key.
  return JSON.stringify(values.map(part));
}
