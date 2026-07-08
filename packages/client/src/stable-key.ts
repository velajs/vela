/**
 * Deterministic JSON encoding for cache/dedup keys: object keys are sorted at
 * every depth so `{a,b}` and `{b,a}` produce the same key (lunora
 * `shared/stable-key.ts` pattern). NOT a wire format — wire frames use plain
 * `JSON.stringify` via @velajs/live-protocol's canonical encoders.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = sortDeep(source[key]);
    }
    return out;
  }
  return value;
}
