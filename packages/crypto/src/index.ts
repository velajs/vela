export interface EncryptionContext {
  readonly namespace: string;
  readonly purpose: string;
  readonly tenantId?: string;
  readonly caller?: Readonly<Record<string, string>>;
}
export interface WrappingKey {
  readonly id: string;
  readonly key: CryptoKey;
}
export interface KeyProvider {
  current(context: EncryptionContext): Promise<WrappingKey>;
  get(id: string, context: EncryptionContext): Promise<CryptoKey | undefined>;
}
export interface AuthenticatedEnvelope {
  readonly v: 1;
  readonly algorithm: 'A256GCM';
  readonly keyId: string;
  readonly wrappedKey: string;
  readonly iv: string;
  readonly ciphertext: string;
}
export interface BinaryCipher {
  encrypt(value: Uint8Array): Promise<string>;
  decrypt(value: string): Promise<Uint8Array<ArrayBuffer>>;
}
export interface TextCipher {
  encryptText(value: string): Promise<string>;
  decryptText(value: string): Promise<string>;
  protect(value: string): Promise<string>;
}
export class CryptoError extends Error {
  constructor(message = 'Encrypted value could not be authenticated', options?: ErrorOptions) {
    super(message, options);
    this.name = 'CryptoError';
  }
}
export const ENVELOPE_PREFIX = 'vela:enc:1:';
const encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', { fatal: true });
export function encodeBase64Url(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
export function decodeBase64Url(value: string, maxBytes = 16_777_216): Uint8Array<ArrayBuffer> {
  if (
    value.length > Math.ceil((maxBytes * 4) / 3) ||
    !/^[A-Za-z0-9_-]*$/.test(value) ||
    value.length % 4 === 1
  )
    throw new CryptoError('Malformed base64url');
  let decoded: string;
  try {
    decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    throw new CryptoError('Malformed base64url');
  }
  const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
  if (bytes.length > maxBytes || encodeBase64Url(bytes) !== value)
    throw new CryptoError('Malformed base64url');
  return bytes;
}
function label(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    encoder.encode(value).length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new TypeError('Invalid encryption context');
  return value.normalize('NFC');
}
export function encryptionContext(input: EncryptionContext): EncryptionContext {
  const entries = Object.entries(input.caller ?? {}).map(([k, v]) => [label(k), label(v)] as const);
  if (new Set(entries.map(([key]) => key)).size !== entries.length)
    throw new TypeError('Duplicate canonical context keys');
  const caller = Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return Object.freeze({
    namespace: label(input.namespace),
    purpose: label(input.purpose),
    ...(input.tenantId === undefined ? {} : { tenantId: label(input.tenantId) }),
    caller: Object.freeze(caller),
  });
}
function wrappingKey(key: CryptoKey): void {
  if (
    key.algorithm.name !== 'AES-KW' ||
    !('length' in key.algorithm) ||
    key.algorithm.length !== 256 ||
    !key.usages.includes('wrapKey') ||
    !key.usages.includes('unwrapKey')
  )
    throw new TypeError('Provider requires a 256-bit AES-KW wrapping key');
}
/** A copied, immutable ring; replace the provider instance when rotating environments. */
export class LocalKeyRing implements KeyProvider {
  readonly #keys: ReadonlyMap<string, CryptoKey>;
  constructor(
    readonly activeKeyId: string,
    keys: ReadonlyMap<string, CryptoKey>,
  ) {
    this.#keys = new Map(keys);
    for (const [id, key] of this.#keys) {
      label(id);
      wrappingKey(key);
    }
    if (!this.#keys.has(activeKeyId)) throw new TypeError('Active wrapping key is missing');
  }
  async current(): Promise<WrappingKey> {
    return { id: this.activeKeyId, key: this.#keys.get(this.activeKeyId)! };
  }
  async get(id: string): Promise<CryptoKey | undefined> {
    return this.#keys.get(id);
  }
  static async fromRaw(
    activeKeyId: string,
    keys: Readonly<Record<string, Uint8Array>>,
  ): Promise<LocalKeyRing> {
    const imported = await Promise.all(
      Object.entries(keys).map(async ([id, raw]) => {
        if (raw.byteLength !== 32)
          throw new TypeError('Wrapping keys must contain 32 random bytes');
        return [
          id,
          await crypto.subtle.importKey('raw', new Uint8Array(raw), 'AES-KW', false, [
            'wrapKey',
            'unwrapKey',
          ]),
        ] as const;
      }),
    );
    return new LocalKeyRing(activeKeyId, new Map(imported));
  }
}
function header(
  envelope: Omit<AuthenticatedEnvelope, 'ciphertext'>,
  context: EncryptionContext,
): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    JSON.stringify([
      envelope.v,
      envelope.algorithm,
      envelope.keyId,
      envelope.wrappedKey,
      envelope.iv,
      context.namespace,
      context.tenantId ?? null,
      context.purpose,
      Object.entries(context.caller ?? {}),
    ]),
  );
}
function parseEnvelope(text: string, maxBytes: number): AuthenticatedEnvelope {
  if (!text.startsWith(ENVELOPE_PREFIX)) throw new CryptoError('Unknown envelope version');
  const value: unknown = JSON.parse(
    decoder.decode(
      decodeBase64Url(text.slice(ENVELOPE_PREFIX.length), Math.ceil((maxBytes * 4) / 3) + 2048),
    ),
  );
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'algorithm,ciphertext,iv,keyId,v,wrappedKey' ||
    !('v' in value) ||
    value.v !== 1 ||
    !('algorithm' in value) ||
    value.algorithm !== 'A256GCM' ||
    !('keyId' in value) ||
    typeof value.keyId !== 'string' ||
    !('wrappedKey' in value) ||
    typeof value.wrappedKey !== 'string' ||
    !('iv' in value) ||
    typeof value.iv !== 'string' ||
    !('ciphertext' in value) ||
    typeof value.ciphertext !== 'string'
  )
    throw new CryptoError('Malformed envelope');
  label(value.keyId);
  return {
    v: 1,
    algorithm: 'A256GCM',
    keyId: value.keyId,
    wrappedKey: value.wrappedKey,
    iv: value.iv,
    ciphertext: value.ciphertext,
  };
}
export class CryptoService {
  readonly #maxBytes: number;
  constructor(
    private readonly provider: KeyProvider,
    options: { maxPlaintextBytes?: number } = {},
  ) {
    this.#maxBytes = options.maxPlaintextBytes ?? 16_777_216;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1 || this.#maxBytes > 67_108_864)
      throw new TypeError('Invalid envelope size limit');
  }
  async encrypt(value: Uint8Array, contextInput: EncryptionContext): Promise<string> {
    if (value.byteLength > this.#maxBytes)
      throw new CryptoError('Plaintext exceeds envelope limit; use file streaming');
    // Snapshot before awaiting a provider: the caller may reuse or resize its buffer.
    const plaintext = new Uint8Array(value);
    const context = encryptionContext(contextInput),
      current = await this.provider.current(context);
    label(current.id);
    wrappingKey(current.key);
    const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
    const wrapped = await crypto.subtle.wrapKey('raw', dek, current.key, 'AES-KW');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const meta = {
      v: 1,
      algorithm: 'A256GCM',
      keyId: current.id,
      wrappedKey: encodeBase64Url(new Uint8Array(wrapped)),
      iv: encodeBase64Url(iv),
    } as const;
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: header(meta, context), tagLength: 128 },
      dek,
      plaintext,
    );
    return (
      ENVELOPE_PREFIX +
      encodeBase64Url(
        encoder.encode(
          JSON.stringify({ ...meta, ciphertext: encodeBase64Url(new Uint8Array(ciphertext)) }),
        ),
      )
    );
  }
  async decrypt(value: string, contextInput: EncryptionContext): Promise<Uint8Array<ArrayBuffer>> {
    const context = encryptionContext(contextInput);
    try {
      const envelope = parseEnvelope(value, this.#maxBytes),
        iv = decodeBase64Url(envelope.iv, 12),
        wrapped = decodeBase64Url(envelope.wrappedKey, 40),
        ciphertext = decodeBase64Url(envelope.ciphertext, this.#maxBytes + 16);
      if (iv.length !== 12 || wrapped.length !== 40 || ciphertext.length < 16)
        throw new CryptoError();
      const key = await this.provider.get(envelope.keyId, context);
      if (!key) throw new CryptoError();
      wrappingKey(key);
      const dek = await crypto.subtle.unwrapKey(
        'raw',
        wrapped,
        key,
        'AES-KW',
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt'],
      );
      return new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv, additionalData: header(envelope, context), tagLength: 128 },
          dek,
          ciphertext,
        ),
      );
    } catch (error) {
      throw new CryptoError(undefined, { cause: error });
    }
  }
  async encryptText(value: string, context: EncryptionContext): Promise<string> {
    return this.encrypt(encoder.encode(value), context);
  }
  async decryptText(value: string, context: EncryptionContext): Promise<string> {
    return decoder.decode(await this.decrypt(value, context));
  }
  async protect(value: string, context: EncryptionContext): Promise<string> {
    if (value.startsWith('vela:enc:')) {
      await this.decrypt(value, context);
      return value;
    }
    return this.encryptText(value, context);
  }
  async reencrypt(value: string, context: EncryptionContext): Promise<string> {
    const plaintext = await this.decrypt(value, context);
    try {
      return await this.encrypt(plaintext, context);
    } finally {
      plaintext.fill(0);
    }
  }
  forContext(input: EncryptionContext): BinaryCipher & TextCipher {
    const context = encryptionContext(input);
    return Object.freeze({
      encrypt: (value: Uint8Array) => this.encrypt(value, context),
      decrypt: (value: string) => this.decrypt(value, context),
      encryptText: (value: string) => this.encryptText(value, context),
      decryptText: (value: string) => this.decryptText(value, context),
      protect: (value: string) => this.protect(value, context),
    });
  }
}
