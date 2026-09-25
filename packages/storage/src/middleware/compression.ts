import { byteLengthOf, toStream } from '../internal/body';
import { createStoredFile } from '../internal/stored-file';
import { StorageError } from '../storage.error';
import type {
  DownloadOptions,
  OperationOptions,
  StoredFile,
  UploadOptions,
} from '../storage.types';
import { passthrough, type RawPreservingMiddleware } from './wrap';

export type CompressionFormat = 'gzip' | 'deflate' | 'deflate-raw';

export interface CompressionOptions {
  /** Stream format. Default `gzip`. */
  format?: CompressionFormat;
  /** What to do when `CompressionStream` is unavailable. Default `throw`. */
  onUnavailable?: 'throw' | 'passthrough';
}

function stripVela(meta: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!meta) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) if (!k.startsWith('vela-')) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

function compressionFormat(file: StoredFile): CompressionFormat {
  const format = file.metadata?.['vela-zip'];
  if (format !== 'gzip' && format !== 'deflate' && format !== 'deflate-raw')
    throw new StorageError('Parse', 'Compressed object requires valid vela-zip metadata');
  return format;
}

/**
 * Transparent gzip/deflate via Web Streams `CompressionStream` — fully
 * streaming, opaque mode (v1). The stored object is compressed and tagged
 * `vela-zip`; reads require a valid format tag and decompress. Range reads / presigned URLs are disabled
 * (the byte stream is not seekable and a direct URL would serve gzip).
 */
export function compression(opts: CompressionOptions = {}): RawPreservingMiddleware {
  const format = opts.format ?? 'gzip';
  const available =
    typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
  if (!available && (opts.onUnavailable ?? 'throw') === 'throw') {
    throw new StorageError('Unsupported', 'CompressionStream is not available in this runtime');
  }

  return (inner) => {
    if (!available) return inner; // explicitly disabled on unsupported runtimes
    if (!inner.supportsMetadata)
      throw new StorageError('Unsupported', 'compression requires metadata support');

    const decompressDownload = async (k: string, _o?: DownloadOptions): Promise<StoredFile> => {
      const file = await inner.download(k);
      const zip = compressionFormat(file);
      const plain = file
        .stream()
        .pipeThrough(
          new DecompressionStream(zip) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
        );
      const size = file.metadata?.['vela-size'] ? Number(file.metadata?.['vela-size']) : file.size;
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
        { kind: 'stream', stream: plain },
      );
    };

    return passthrough(
      inner,
      {
        reportsUploadProgress: false,
        supportsRange: false,
        signedUrl: { supported: false, upload: false },
        async upload(k, body, o?: UploadOptions) {
          const zipped = toStream(body).pipeThrough(
            new CompressionStream(format) as unknown as ReadableWritablePair<
              Uint8Array,
              Uint8Array
            >,
          );
          const metadata: Record<string, string> = { ...o?.metadata, 'vela-zip': format };
          if (o?.contentType) metadata['vela-ct'] = o.contentType;
          const known = byteLengthOf(body);
          if (known != null) metadata['vela-size'] = String(known);
          const r = await inner.upload(k, zipped, {
            ...o,
            metadata: inner.supportsMetadata ? metadata : undefined,
            contentType: 'application/octet-stream',
          });
          return {
            ...r,
            size: known ?? r.size,
            contentType: o?.contentType ?? 'application/octet-stream',
          };
        },
        download: decompressDownload,
        async head(k, o?: OperationOptions) {
          const file = await inner.head(k, o);
          compressionFormat(file);
          const size = file.metadata?.['vela-size']
            ? Number(file.metadata?.['vela-size'])
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
            {
              kind: 'lazy',
              fetch: async () => new Response((await decompressDownload(k)).stream()),
            },
          );
        },
        url() {
          throw new StorageError('Unsupported', 'compression: url() would serve compressed bytes');
        },
        signedUploadUrl() {
          throw new StorageError(
            'Unsupported',
            'compression: signed uploads would store uncompressed',
          );
        },
      },
      ['createMultipartUpload', 'resumeMultipartUpload', 'signedMultipart'],
    );
  };
}
