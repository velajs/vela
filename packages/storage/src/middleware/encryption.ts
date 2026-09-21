import { toBytes } from '../internal/body';
import { createStoredFile } from '../internal/stored-file';
import { StorageError } from '../storage.error';
import type {
  DownloadOptions,
  OperationOptions,
  StoredFile,
  UploadOptions,
} from '../storage.types';
import { passthrough, type RawPreservingMiddleware } from './wrap';

export interface EncryptionOptions {
  /** A 256-bit AES-GCM key: a `CryptoKey` or 32 raw bytes. */
  key: CryptoKey | Uint8Array;
  /** How to treat objects that aren't valid ciphertext (legacy data). Default `throw`. */
  onInvalid?: 'throw' | 'passthrough';
}

const IV_BYTES = 12;

// The Web Crypto typings pin BufferSource to ArrayBuffer-backed views; our byte
// views are ArrayBufferLike-typed. They are ArrayBuffer-backed at runtime, so a
// narrowing cast is safe and confined to this helper.
const asBuf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

function stripVela(meta: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!meta) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) if (!k.startsWith('vela-')) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

async function importKey(key: CryptoKey | Uint8Array): Promise<CryptoKey> {
  if (key instanceof Uint8Array) {
    return crypto.subtle.importKey(
      'raw',
      key as unknown as ArrayBuffer,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
  }
  return key;
}

/**
 * Transparent client-side encryption via Web Crypto AES-GCM. v1 encrypts the
 * WHOLE object (buffered); the stored object is `IV(12) || ciphertext+tag`.
 * Range reads, presigned URLs, and multipart are disabled (a signed URL would
 * hand out ciphertext / accept plaintext, defeating the invariant).
 */
export function encryption(opts: EncryptionOptions): RawPreservingMiddleware {
  const keyPromise = importKey(opts.key);

  return (inner) => {
    const decryptDownload = async (k: string, _o?: DownloadOptions): Promise<StoredFile> => {
      const file = await inner.download(k);
      const framed = new Uint8Array(await file.arrayBuffer());
      if (framed.byteLength < IV_BYTES) {
        if (opts.onInvalid === 'passthrough') return file;
        throw new StorageError('Parse', `object too small to be encrypted: ${k}`);
      }
      const iv = framed.subarray(0, IV_BYTES);
      const ciphertext = framed.subarray(IV_BYTES);
      const key = await keyPromise;
      let plain: Uint8Array;
      try {
        plain = new Uint8Array(
          await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBuf(iv) }, key, asBuf(ciphertext)),
        );
      } catch (e) {
        if (opts.onInvalid === 'passthrough') return file;
        throw new StorageError('Provider', `decryption failed: ${k}`, { cause: e });
      }
      return createStoredFile(
        {
          key: k,
          name: file.name,
          size: plain.byteLength,
          type: file.metadata?.['vela-ct'] ?? file.type,
          lastModified: file.lastModified,
          etag: file.etag,
          metadata: stripVela(file.metadata),
        },
        { kind: 'bytes', bytes: plain },
      );
    };

    return passthrough(
      inner,
      {
        reportsUploadProgress: false,
        supportsRange: false,
        signedUrl: { supported: false, upload: false },
        async upload(k, body, o?: UploadOptions) {
          const plaintext = await toBytes(body);
          const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
          const key = await keyPromise;
          const ct = new Uint8Array(
            await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, asBuf(plaintext)),
          );
          const framed = new Uint8Array(IV_BYTES + ct.byteLength);
          framed.set(iv, 0);
          framed.set(ct, IV_BYTES);

          const metadata: Record<string, string> = { ...o?.metadata, 'vela-enc': 'AES-GCM' };
          if (o?.contentType) metadata['vela-ct'] = o.contentType;
          metadata['vela-size'] = String(plaintext.byteLength);

          const r = await inner.upload(k, framed, {
            ...o,
            metadata: inner.supportsMetadata ? metadata : undefined,
            contentType: 'application/octet-stream',
          });
          return {
            ...r,
            size: plaintext.byteLength,
            contentType: o?.contentType ?? 'application/octet-stream',
          };
        },
        download: decryptDownload,
        async head(k, o?: OperationOptions) {
          const file = await inner.head(k, o);
          const size = file.metadata?.['vela-size']
            ? Number(file.metadata['vela-size'])
            : file.size;
          return createStoredFile(
            {
              key: k,
              name: file.name,
              size,
              type: file.metadata?.['vela-ct'] ?? file.type,
              lastModified: file.lastModified,
              etag: file.etag,
              metadata: stripVela(file.metadata),
            },
            { kind: 'lazy', fetch: async () => new Response((await decryptDownload(k)).stream()) },
          );
        },
        url() {
          throw new StorageError('Unsupported', 'encryption: url() would expose ciphertext');
        },
        signedUploadUrl() {
          throw new StorageError('Unsupported', 'encryption: signed uploads would store plaintext');
        },
      },
      ['createMultipartUpload', 'resumeMultipartUpload', 'signedMultipart'],
    );
  };
}
