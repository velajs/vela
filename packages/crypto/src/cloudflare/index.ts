import {
  CryptoError,
  decodeBase64Url,
  encodeBase64Url,
  type KeyProvider,
  type WrappingKey,
} from '../index';

/** Structural subset of a native Secrets Store secret binding. */
export interface SecretsStoreSecret {
  get(): Promise<string>;
}

export interface SecretsStoreKeyProviderOptions {
  /** Immutable envelope key ID. Rotate by creating a provider with a new ID and binding. */
  readonly activeKeyId: string;
  /** One canonical, unpadded base64url-encoded 32-byte key per immutable ID. */
  readonly keys: Readonly<Record<string, SecretsStoreSecret>>;
  /** Imported-key cache lifetime. Default 0: re-read on each operation. No stale-on-error. */
  readonly cacheTtlMs?: number;
}

interface CachedKey {
  readonly pending: Promise<CryptoKey>;
  expiresAt: number;
}

/**
 * Loads AES-KW material from environment-owned Secrets Store bindings. This is
 * key distribution, not a remote KMS: wrap/unwrap runs in local Web Crypto.
 * Construct once per environment; no bindings, keys or in-flight reads are global.
 */
export class SecretsStoreKeyProvider implements KeyProvider {
  readonly #activeKeyId: string;
  readonly #bindings: ReadonlyMap<string, SecretsStoreSecret>;
  readonly #ttl: number;
  readonly #cache = new Map<string, CachedKey>();
  // Retained across refreshes to reject reassignment of an already observed ID.
  readonly #fingerprints = new Map<string, string>();

  constructor(options: SecretsStoreKeyProviderOptions) {
    validateId(options.activeKeyId);
    this.#activeKeyId = options.activeKeyId;
    this.#ttl = options.cacheTtlMs ?? 0;
    if (!Number.isSafeInteger(this.#ttl) || this.#ttl < 0)
      throw new TypeError('Invalid key cache lifetime');
    const entries = Object.entries(options.keys);
    for (const [id, binding] of entries) {
      validateId(id);
      if (!binding || typeof binding.get !== 'function')
        throw new TypeError('Invalid Secrets Store binding');
    }
    this.#bindings = new Map(entries);
    if (!this.#bindings.has(this.#activeKeyId))
      throw new TypeError('Active wrapping key is missing');
  }

  get activeKeyId(): string {
    return this.#activeKeyId;
  }

  async current(): Promise<WrappingKey> {
    return { id: this.#activeKeyId, key: (await this.get(this.#activeKeyId))! };
  }

  async get(id: string): Promise<CryptoKey | undefined> {
    const binding = this.#bindings.get(id);
    if (!binding) return undefined;
    const cached = this.#cache.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached.pending;
    const entry: CachedKey = {
      pending: this.load(id, binding),
      expiresAt: Infinity,
    };
    this.#cache.set(id, entry);
    try {
      const key = await entry.pending;
      entry.expiresAt = Date.now() + this.#ttl;
      return key;
    } catch (error) {
      // A refresh may have installed a newer read while this one was pending.
      if (this.#cache.get(id) === entry) this.#cache.delete(id);
      throw error;
    }
  }

  /**
   * Evict imported keys; the next operation re-reads the binding. Already running
   * operations may finish with their key. ID fingerprints survive invalidation.
   */
  invalidate(id?: string): void {
    if (id === undefined) this.#cache.clear();
    else this.#cache.delete(id);
  }

  private async load(id: string, binding: SecretsStoreSecret): Promise<CryptoKey> {
    let raw: Uint8Array<ArrayBuffer> | undefined;
    try {
      const encoded = await binding.get();
      if (typeof encoded !== 'string') throw new Error();
      raw = decodeBase64Url(encoded, 32);
      if (raw.length !== 32) throw new Error();
      const fingerprint = encodeBase64Url(
        new Uint8Array(await crypto.subtle.digest('SHA-256', raw)),
      );
      const previous = this.#fingerprints.get(id);
      if (previous !== undefined && previous !== fingerprint) throw new Error();
      // Pin before another load can pass the check after an invalidation.
      this.#fingerprints.set(id, fingerprint);
      return await crypto.subtle.importKey('raw', raw, 'AES-KW', false, ['wrapKey', 'unwrapKey']);
    } catch {
      // Do not retain a binding's error/cause, IDs, secret text or decoded bytes.
      throw new CryptoError('Secrets Store wrapping key could not be loaded');
    } finally {
      raw?.fill(0);
    }
  }
}

function validateId(id: string): void {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))
    throw new TypeError('Invalid immutable wrapping key ID');
}
