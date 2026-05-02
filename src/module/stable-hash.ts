/**
 * Deterministic, sync, edge-safe hash for module-instance discrimination.
 *
 * Walks values (objects/arrays/primitives/functions/class instances) into a
 * sorted, source-fingerprinting JSON string, then runs FNV-1a (32-bit) for a
 * compact 8-hex-char output.
 *
 * Functions and class instances are tolerated — they become `__fn:source` or
 * `__cls:ClassName` markers. Two distinct closures with the same source code
 * collide; module authors who care about that should pass an explicit `key`.
 *
 * Not cryptographic. Sufficient for discriminating module instances within
 * an app.
 */
export function stableHash(value: unknown): string {
  return fnv1a(stableStringify(value));
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value) ?? 'undefined';

  const t = typeof value;

  if (t === 'function') {
    // Source-fingerprint via FNV-1a so we don't bloat the parent hash; this
    // keeps two distinct factory functions distinguishable as long as their
    // source differs (the common case). Names are intentionally excluded —
    // two arrow functions with the same body should dedup.
    return `__fn:${fnv1a((value as { toString(): string }).toString())}`;
  }

  if (t === 'symbol') {
    return `__sym:${(value as symbol).description ?? ''}`;
  }

  if (t !== 'object') return JSON.stringify(value);

  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) {
    const ctor = (value as { constructor?: { name?: string } }).constructor;
    const name = ctor?.name ?? 'AnonymousClass';
    // Walk own enumerable properties so two instances of the same class with
    // different state still hash differently, but identity-only state (e.g.,
    // closures captured in methods) is not part of the fingerprint.
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]));
    return `__cls:${name}{` + parts.join(',') + '}';
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]));
  return '{' + parts.join(',') + '}';
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
