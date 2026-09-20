import { concatChunks, toBytes } from '../../internal/body';
import { createStoredFile } from '../../internal/stored-file';
import { StorageError } from '../../storage.error';
import type {
  Body,
  CreateMultipartOptions,
  DownloadOptions,
  ListOptions,
  ListResult,
  MultipartUpload,
  StorageDriver,
  StoredFile,
  UploadOptions,
  UploadResult,
} from '../../storage.types';

export interface MemoryEntry {
  bytes: Uint8Array;
  contentType: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
  etag: string;
  lastModified: number;
}

export interface MemoryDriverOptions {
  /** Pre-seed the store with `{ key: bytes|string }`. */
  initial?: Record<string, Uint8Array | string>;
}

export type MemoryDriver = StorageDriver<Map<string, MemoryEntry>>;

// FNV-1a 64-bit content hash — deterministic, edge-safe (BigInt, no node:crypto).
// Memory is a dev/test driver; the ETag never interoperates with real S3 ETags.
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64 = 0xffffffffffffffffn;

function contentEtag(bytes: Uint8Array): string {
  let h = FNV_OFFSET;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * FNV_PRIME) & U64;
  }
  return `"${h.toString(16).padStart(16, '0')}"`;
}

function makeEntry(bytes: Uint8Array, opts?: UploadOptions | CreateMultipartOptions): MemoryEntry {
  return {
    bytes,
    contentType: opts?.contentType ?? 'application/octet-stream',
    cacheControl: opts?.cacheControl,
    metadata: opts?.metadata,
    etag: contentEtag(bytes),
    lastModified: Date.now(),
  };
}

/** In-memory storage driver — the test/dev workhorse and reference impl. */
export function memoryDriver(options?: MemoryDriverOptions): MemoryDriver {
  const store = new Map<string, MemoryEntry>();
  const encoder = new TextEncoder();

  for (const [key, value] of Object.entries(options?.initial ?? {})) {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    store.set(key, makeEntry(bytes));
  }

  const toStored = (key: string, entry: MemoryEntry, bytes: Uint8Array): StoredFile =>
    createStoredFile(
      {
        key,
        size: bytes.byteLength,
        type: entry.contentType,
        lastModified: entry.lastModified,
        etag: entry.etag,
        metadata: entry.metadata,
      },
      { kind: 'bytes', bytes },
    );

  const mustGet = (key: string): MemoryEntry => {
    const e = store.get(key);
    if (!e) throw new StorageError('NotFound', `object not found: ${key}`);
    return e;
  };

  return {
    name: 'memory',
    raw: store,
    supportsRange: true,
    supportsDelimiter: true,
    supportsMetadata: true,
    supportsCacheControl: true,
    supportsServerSideCopy: true,
    reportsUploadProgress: false,
    signedUrl: { supported: false, upload: false },

    async upload(key: string, body: Body, opts?: UploadOptions): Promise<UploadResult> {
      const bytes = await toBytes(body);
      const entry = makeEntry(bytes, opts);
      store.set(key, entry);
      return {
        key,
        size: bytes.byteLength,
        contentType: entry.contentType,
        etag: entry.etag,
        lastModified: entry.lastModified,
      };
    },

    async download(key: string, opts?: DownloadOptions): Promise<StoredFile> {
      const entry = mustGet(key);
      if (opts?.range) {
        const start = opts.range.start;
        const end = opts.range.end ?? entry.bytes.byteLength - 1;
        return toStored(key, entry, entry.bytes.subarray(start, end + 1));
      }
      return toStored(key, entry, entry.bytes);
    },

    async head(key: string): Promise<StoredFile> {
      const entry = mustGet(key);
      return toStored(key, entry, entry.bytes);
    },

    async exists(key: string): Promise<boolean> {
      return store.has(key);
    },

    async delete(key: string): Promise<void> {
      store.delete(key);
    },

    async deleteMany(keys: string[]) {
      for (const k of keys) store.delete(k);
      return { deleted: keys };
    },

    async copy(from: string, to: string): Promise<void> {
      const e = mustGet(from);
      store.set(to, { ...e, bytes: e.bytes.slice(), lastModified: Date.now() });
    },

    async move(from: string, to: string): Promise<void> {
      const e = mustGet(from);
      store.set(to, e);
      store.delete(from);
    },

    async list(opts?: ListOptions): Promise<ListResult> {
      const prefix = opts?.prefix ?? '';
      const delimiter = opts?.delimiter;
      const limit = opts?.limit ?? 1000;
      const start = opts?.cursor ? Number.parseInt(opts.cursor, 10) : 0;
      const matched = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();

      if (delimiter) {
        const prefixes = new Set<string>();
        const direct: string[] = [];
        for (const k of matched) {
          const rest = k.slice(prefix.length);
          const idx = rest.indexOf(delimiter);
          if (idx === -1) direct.push(k);
          else prefixes.add(prefix + rest.slice(0, idx + delimiter.length));
        }
        const page = direct.slice(start, start + limit);
        const cursor = start + limit < direct.length ? String(start + limit) : undefined;
        return {
          items: page.map((k) => toStored(k, mustGet(k), mustGet(k).bytes)),
          prefixes: start === 0 && prefixes.size ? [...prefixes].sort() : undefined,
          cursor,
        };
      }

      const page = matched.slice(start, start + limit);
      const cursor = start + limit < matched.length ? String(start + limit) : undefined;
      return {
        items: page.map((k) => toStored(k, mustGet(k), mustGet(k).bytes)),
        cursor,
      };
    },

    async url(key: string): Promise<string> {
      throw new StorageError('Unsupported', 'memory driver cannot mint URLs');
    },

    async signedUploadUrl(): Promise<never> {
      throw new StorageError('Unsupported', 'memory driver cannot presign uploads');
    },

    async createMultipartUpload(
      key: string,
      opts?: CreateMultipartOptions,
    ): Promise<MultipartUpload> {
      const uploadId = crypto.randomUUID();
      const parts = new Map<number, Uint8Array>();
      return {
        key,
        uploadId,
        async uploadPart(partNumber, body) {
          const bytes = await toBytes(body);
          parts.set(partNumber, bytes);
          return { partNumber, etag: contentEtag(bytes), size: bytes.byteLength };
        },
        async complete(uploaded) {
          const ordered = [...uploaded]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => {
              const bytes = parts.get(p.partNumber);
              if (!bytes) throw new StorageError('InvalidRequest', `missing part ${p.partNumber}`);
              return bytes;
            });
          const all = concatChunks(ordered);
          const entry = makeEntry(all, opts);
          store.set(key, entry);
          return {
            key,
            size: all.byteLength,
            contentType: entry.contentType,
            etag: entry.etag,
            lastModified: entry.lastModified,
          };
        },
        async abort() {
          parts.clear();
        },
        async listParts() {
          return [...parts.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([partNumber, bytes]) => ({
              partNumber,
              etag: contentEtag(bytes),
              size: bytes.byteLength,
            }));
        },
      };
    },
  };
}
