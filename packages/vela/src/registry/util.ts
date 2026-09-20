// Single map.get + optional set. Replaces `map.has(key) || map.set(key, …); map.get(key)!` patterns.
export function getOrCreate<K, V>(map: Map<K, V>, key: K, factory: () => V): V {
  let v = map.get(key);
  if (v === undefined) map.set(key, (v = factory()));
  return v;
}

export const getOrCreateMap = <K, NK, NV>(map: Map<K, Map<NK, NV>>, key: K) =>
  getOrCreate(map, key, () => new Map<NK, NV>());

export const getOrCreateArray = <K, V>(map: Map<K, V[]>, key: K) =>
  getOrCreate(map, key, () => [] as V[]);
