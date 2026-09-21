import { CryptoError, encodeBase64Url, decodeBase64Url, type BinaryCipher } from '../index';
const encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', { fatal: true });
const MAGIC = encoder.encode('VELAF1\n');
const MAX_CHUNK = 1_048_576,
  MAX_HEADER = 65_536;
function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
function uint32(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}
function count(value: Uint8Array): number {
  return new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(0);
}
function nonce(id: Uint8Array, sequence: number): Uint8Array<ArrayBuffer> {
  return concat(id.subarray(0, 8), uint32(sequence));
}
/** Holds one upstream chunk and at most one frame allocation; never buffers a file. */
class Bytes {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #chunk: Uint8Array = new Uint8Array();
  #offset = 0;
  #closed = false;
  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }
  async read(length: number, partial = false): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const out = new Uint8Array(length);
    let written = 0,
      empty = 0;
    while (written < length) {
      if (this.#offset === this.#chunk.length) {
        if (this.#closed) break;
        const next = await this.#reader.read();
        if (next.done) {
          this.#closed = true;
          this.#reader.releaseLock();
          break;
        }
        if (!(next.value instanceof Uint8Array)) throw new CryptoError('Expected byte stream');
        if (next.value.length === 0 && ++empty > 100)
          throw new CryptoError('Stream made no progress');
        this.#chunk = next.value;
        this.#offset = 0;
      }
      const take = Math.min(length - written, this.#chunk.length - this.#offset);
      out.set(this.#chunk.subarray(this.#offset, this.#offset + take), written);
      written += take;
      this.#offset += take;
    }
    if (written === 0) return undefined;
    if (written !== length && !partial) throw new CryptoError('Truncated encrypted stream');
    return written === length ? out : out.slice(0, written);
  }
  async exact(length: number): Promise<Uint8Array<ArrayBuffer>> {
    const result = await this.read(length);
    if (!result) throw new CryptoError('Truncated encrypted stream');
    return result;
  }
  async cancel(reason: unknown): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#reader.cancel(reason);
    } finally {
      this.#reader.releaseLock();
      this.#chunk = new Uint8Array();
    }
  }
}
export interface FileEncryptionOptions {
  chunkSize?: number;
  signal?: AbortSignal;
}
/** Each frame authenticates its header, sequence and completion marker. */
export async function encryptFile(
  input: ReadableStream<Uint8Array>,
  cipher: BinaryCipher,
  options: FileEncryptionOptions = {},
): Promise<ReadableStream<Uint8Array>> {
  const chunkSize = options.chunkSize ?? 65_536;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK)
    throw new TypeError('Invalid encrypted file chunk size');
  options.signal?.throwIfAborted();
  const rawKey = crypto.getRandomValues(new Uint8Array(32)),
    id = crypto.getRandomValues(new Uint8Array(16));
  let sealedKey: string, key: CryptoKey;
  try {
    sealedKey = await cipher.encrypt(rawKey);
    key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  } finally {
    rawKey.fill(0);
  }
  const header = encoder.encode(
    JSON.stringify({ v: 1, chunkSize, id: encodeBase64Url(id), key: sealedKey }),
  );
  if (header.length > MAX_HEADER) throw new CryptoError('File header too large');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', header)),
    bytes = new Bytes(input);
  let sequence = 0,
    total = 0,
    started = false,
    closed = false;
  const aborted = () => {
    closed = true;
    void bytes.cancel(options.signal?.reason).catch(() => {});
  };
  options.signal?.addEventListener('abort', aborted, { once: true });
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          options.signal?.throwIfAborted();
          if (closed) throw new CryptoError('File encryption cancelled');
          if (!started) {
            started = true;
            controller.enqueue(concat(MAGIC, uint32(header.length), header));
            return;
          }
          if (sequence >= 0xffff_ffff) throw new CryptoError('File has too many frames');
          const chunk = await bytes.read(chunkSize, true);
          const final = chunk === undefined;
          const plain = chunk ?? new Uint8Array(8);
          if (final) new DataView(plain.buffer).setBigUint64(0, BigInt(total));
          else {
            total += plain.length;
            if (!Number.isSafeInteger(total)) throw new CryptoError('File exceeds length limit');
          }
          const prefix = concat(
            uint32(sequence),
            new Uint8Array([final ? 1 : 0]),
            uint32(plain.length + 16),
          );
          const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: nonce(id, sequence), additionalData: concat(hash, prefix) },
            key,
            plain,
          );
          options.signal?.throwIfAborted();
          if (closed) return;
          controller.enqueue(concat(prefix, new Uint8Array(encrypted)));
          sequence++;
          if (final) {
            closed = true;
            options.signal?.removeEventListener('abort', aborted);
            controller.close();
          }
        } catch (error) {
          closed = true;
          options.signal?.removeEventListener('abort', aborted);
          await bytes.cancel(error);
          controller.error(error);
        }
      },
      async cancel(reason) {
        closed = true;
        options.signal?.removeEventListener('abort', aborted);
        await bytes.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}
/** Plaintext chunks are authenticated individually. Successful EOF authenticates completeness. */
export function decryptFile(
  input: ReadableStream<Uint8Array>,
  cipher: BinaryCipher,
  options: { signal?: AbortSignal; maxChunkSize?: number } = {},
): ReadableStream<Uint8Array> {
  const max = options.maxChunkSize ?? MAX_CHUNK;
  if (!Number.isSafeInteger(max) || max < 1 || max > MAX_CHUNK)
    throw new TypeError('Invalid decryption chunk limit');
  const bytes = new Bytes(input);
  let key: CryptoKey | undefined,
    id: Uint8Array = new Uint8Array(),
    hash: Uint8Array = new Uint8Array(),
    chunkSize = 0,
    sequence = 0,
    total = 0,
    closed = false;
  const aborted = () => {
    closed = true;
    void bytes.cancel(options.signal?.reason).catch(() => {});
  };
  options.signal?.addEventListener('abort', aborted, { once: true });
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          options.signal?.throwIfAborted();
          if (closed) throw new CryptoError('File decryption cancelled');
          if (!key) {
            const magic = await bytes.exact(MAGIC.length);
            if (!magic.every((v, i) => v === MAGIC[i]))
              throw new CryptoError('Unknown encrypted file format');
            const size = count(await bytes.exact(4));
            if (size < 1 || size > MAX_HEADER) throw new CryptoError('Invalid file header size');
            const header = await bytes.exact(size),
              value: unknown = JSON.parse(decoder.decode(header));
            if (
              !value ||
              typeof value !== 'object' ||
              !('v' in value) ||
              value.v !== 1 ||
              !('chunkSize' in value) ||
              typeof value.chunkSize !== 'number' ||
              !Number.isSafeInteger(value.chunkSize) ||
              value.chunkSize < 1 ||
              value.chunkSize > max ||
              !('id' in value) ||
              typeof value.id !== 'string' ||
              !('key' in value) ||
              typeof value.key !== 'string' ||
              Object.keys(value).sort().join(',') !== 'chunkSize,id,key,v'
            )
              throw new CryptoError('Malformed file header');
            chunkSize = value.chunkSize;
            id = decodeBase64Url(value.id, 16);
            if (id.length !== 16) throw new CryptoError('Invalid stream ID');
            const rawKey = await cipher.decrypt(value.key);
            try {
              if (rawKey.length !== 32) throw new CryptoError('Invalid file key');
              key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
            } finally {
              rawKey.fill(0);
            }
            hash = new Uint8Array(await crypto.subtle.digest('SHA-256', header));
          }
          const prefix = await bytes.exact(9),
            seq = count(prefix.subarray(0, 4)),
            type = prefix[4],
            length = count(prefix.subarray(5));
          if (
            seq !== sequence ||
            sequence >= 0xffff_ffff ||
            (type !== 0 && type !== 1) ||
            length < 16 ||
            length > (type === 1 ? 24 : chunkSize + 16) ||
            (type === 0 && length === 16) ||
            (type === 1 && length !== 24)
          )
            throw new CryptoError('Invalid encrypted frame');
          const encrypted = await bytes.exact(length);
          const plain = new Uint8Array(
            await crypto.subtle.decrypt(
              { name: 'AES-GCM', iv: nonce(id, sequence), additionalData: concat(hash, prefix) },
              key,
              encrypted,
            ),
          );
          sequence++;
          options.signal?.throwIfAborted();
          if (closed) return;
          if (type === 1) {
            if (
              new DataView(plain.buffer).getBigUint64(0) !== BigInt(total) ||
              (await bytes.read(1))
            )
              throw new CryptoError('Invalid authenticated file completion');
            closed = true;
            options.signal?.removeEventListener('abort', aborted);
            controller.close();
            return;
          }
          total += plain.length;
          if (!Number.isSafeInteger(total)) throw new CryptoError('File exceeds length limit');
          controller.enqueue(plain);
        } catch (error) {
          closed = true;
          options.signal?.removeEventListener('abort', aborted);
          await bytes.cancel(error);
          controller.error(
            error instanceof CryptoError ? error : new CryptoError(undefined, { cause: error }),
          );
        }
      },
      async cancel(reason) {
        closed = true;
        options.signal?.removeEventListener('abort', aborted);
        await bytes.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/** Structural R2 interface keeps native Worker globals out of portable declarations. */
export interface EncryptedObjectBucket {
  createMultipartUpload(
    key: string,
    options?: { httpMetadata?: { contentType: string } },
  ): Promise<{
    uploadPart(part: number, body: ArrayBuffer): Promise<{ partNumber: number; etag: string }>;
    complete(parts: { partNumber: number; etag: string }[]): Promise<unknown>;
    abort(): Promise<void>;
  }>;
  get(key: string): Promise<{ body: ReadableStream<Uint8Array> } | null>;
}
/** R2 commits only after the encrypted stream reaches its authenticated completion. */
export async function encryptToR2(
  bucket: EncryptedObjectBucket,
  objectKey: string,
  input: ReadableStream<Uint8Array>,
  cipher: BinaryCipher,
  options: FileEncryptionOptions = {},
): Promise<unknown> {
  const stream = await encryptFile(input, cipher, options),
    bytes = new Bytes(stream);
  let upload: Awaited<ReturnType<EncryptedObjectBucket['createMultipartUpload']>> | undefined;
  const parts: { partNumber: number; etag: string }[] = [];
  try {
    upload = await bucket.createMultipartUpload(objectKey, {
      httpMetadata: { contentType: 'application/vnd.vela.encrypted' },
    });
    for (let part = 1; ; part++) {
      options.signal?.throwIfAborted();
      const body = await bytes.read(5 * 1024 * 1024, true);
      if (!body) break;
      if (part > 10_000) throw new CryptoError('R2 multipart limit exceeded');
      parts.push(await upload.uploadPart(part, body.buffer));
    }
    options.signal?.throwIfAborted();
    return await upload.complete(parts);
  } catch (error) {
    await bytes.cancel(error);
    try {
      await upload?.abort();
    } catch {
      /* Preserve the upload failure; R2 lifecycle rules handle abandoned uploads. */
    }
    throw error;
  }
}
export async function decryptFromR2(
  bucket: EncryptedObjectBucket,
  objectKey: string,
  cipher: BinaryCipher,
  options: { signal?: AbortSignal } = {},
): Promise<ReadableStream<Uint8Array> | null> {
  const object = await bucket.get(objectKey);
  return object ? decryptFile(object.body, cipher, options) : null;
}
