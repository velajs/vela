const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x00000100000001b3n;
const U64_MASK = 0xffffffffffffffffn;

/**
 * A synchronous, **non-cryptographic** 64-bit FNV-1a hash of `text`, returned as
 * 16 lowercase hex characters.
 *
 * This exists purely for **change detection** — "has this document's text
 * changed since the last sync?" It runs everywhere with no async ceremony (no
 * `crypto.subtle`, no `node:crypto`). It is NOT collision-resistant and MUST
 * NOT be used as a security, integrity, deduplication-of-untrusted-input, or MAC
 * primitive. RAG sync uses a separate SHA-256 fingerprint.
 */
export const contentHash = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let hash = FNV_OFFSET_BASIS;

  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & U64_MASK;
  }

  return hash.toString(16).padStart(16, '0');
};
