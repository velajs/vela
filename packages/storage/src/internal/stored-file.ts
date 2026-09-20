import { StorageError } from '../storage.error';
import type { StoredFile } from '../storage.types';

export interface StoredFileMeta {
  key: string;
  name?: string;
  size: number;
  type?: string;
  lastModified?: number;
  etag?: string;
  metadata?: Record<string, string>;
}

/**
 * Where a {@link StoredFile}'s bytes come from:
 * - `bytes`  — already in memory (memory driver, buffered reads).
 * - `stream` — a single-use byte stream (a live download response body).
 * - `lazy`   — a thunk that issues the GET on first body access (head()).
 */
export type StoredFileSource =
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'stream'; stream: ReadableStream<Uint8Array> }
  | { kind: 'lazy'; fetch: () => Promise<Response> };

function nameFromKey(key: string): string {
  const i = key.lastIndexOf('/');
  return i === -1 ? key : key.slice(i + 1);
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

class StoredFileImpl implements StoredFile {
  readonly key: string;
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly lastModified?: number;
  readonly etag?: string;
  readonly metadata?: Record<string, string>;

  #source: StoredFileSource;
  #bytes: Uint8Array | undefined;
  #streamTaken = false;

  constructor(meta: StoredFileMeta, source: StoredFileSource) {
    this.key = meta.key;
    this.name = meta.name ?? nameFromKey(meta.key);
    this.size = meta.size;
    this.type = meta.type ?? 'application/octet-stream';
    this.lastModified = meta.lastModified;
    this.etag = meta.etag;
    this.metadata = meta.metadata;
    this.#source = source;
    if (source.kind === 'bytes') this.#bytes = source.bytes;
  }

  async #buffer(): Promise<Uint8Array> {
    if (this.#bytes) return this.#bytes;
    const s = this.#source;
    if (s.kind === 'bytes') {
      this.#bytes = s.bytes;
      return this.#bytes;
    }
    if (s.kind === 'stream') {
      if (this.#streamTaken) {
        throw new StorageError('Provider', `body of ${this.key} already consumed`);
      }
      this.#streamTaken = true;
      this.#bytes = new Uint8Array(await new Response(s.stream).arrayBuffer());
      return this.#bytes;
    }
    // s.kind === 'lazy'
    const res = await s.fetch();
    if (!res.ok) throw StorageError.fromStatus(res.status, `download failed: ${this.key}`);
    this.#bytes = new Uint8Array(await res.arrayBuffer());
    return this.#bytes;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return toArrayBuffer(await this.#buffer());
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.#buffer());
  }

  async blob(): Promise<Blob> {
    const b = await this.#buffer();
    return new Blob([toArrayBuffer(b)], { type: this.type });
  }

  stream(): ReadableStream<Uint8Array> {
    if (this.#bytes) return bytesToStream(this.#bytes);
    const s = this.#source;
    if (s.kind === 'bytes') return bytesToStream(s.bytes);
    if (s.kind === 'stream') {
      if (this.#streamTaken) {
        throw new StorageError('Provider', `body of ${this.key} already consumed`);
      }
      this.#streamTaken = true;
      return s.stream;
    }
    // lazy: fetch on first pull
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const fetchFn = s.fetch;
    const key = this.key;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        let r = reader;
        if (!r) {
          const res = await fetchFn();
          if (!res.ok || !res.body) {
            throw StorageError.fromStatus(res.status, `download failed: ${key}`);
          }
          r = res.body.getReader();
          reader = r;
        }
        const { done, value } = await r.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel(reason) {
        return reader?.cancel(reason);
      },
    });
  }
}

export function createStoredFile(meta: StoredFileMeta, source: StoredFileSource): StoredFile {
  return new StoredFileImpl(meta, source);
}
