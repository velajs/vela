// Browser upload client for @velajs/storage. Framework-agnostic, zero-dep.
// Ships from the `./client` subpath (DOM code, not edge code). Talks to the
// StorageController's JSON control-plane over fetch, and uploads bytes DIRECTLY
// to the bucket via presigned URLs (XHR for progress; fetch has no upload
// progress event). Wire types are imported type-only.

import type { UploadedPart, UploadResult } from '../storage.types';
import type {
  DeleteRequest,
  ListResponse,
  MultipartCreateResponse,
  SignPartResponse,
  SignUploadResponse,
  StorageErrorBody,
} from '../http/protocol.types';
import type { DeleteManyResult } from '../storage.types';

const DEFAULT_MULTIPART_THRESHOLD = 16 * 1024 * 1024; // 16 MiB
const DEFAULT_CONCURRENCY = 4;

export interface StorageClientOptions {
  /** Base URL of the mounted controller, e.g. `/api/storage`. */
  baseUrl: string;
  /** Per-request headers (auth token/cookie). */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Override fetch (SSR/tests). */
  fetch?: typeof fetch;
  /** Files larger than this switch to multipart. Default 16 MiB. */
  multipartThreshold?: number;
}

export interface ClientUploadOptions {
  /** Object key. Defaults to the file's name. The server may override it. */
  key?: string;
  contentType?: string;
  metadata?: Record<string, string>;
  multipart?: boolean | { partSize?: number; concurrency?: number };
  onProgress?: (p: { loaded: number; total: number }) => void;
  signal?: AbortSignal;
  /** Stable id enabling resume across reloads (multipart only). */
  resumeKey?: string;
}

export class StorageClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'StorageClientError';
  }
  static async from(res: Response): Promise<StorageClientError> {
    let code = 'upstream_error';
    let message = `request failed: ${res.status}`;
    try {
      const body = (await res.json()) as StorageErrorBody;
      if (body?.error) {
        code = body.error.code;
        message = body.error.message;
      }
    } catch {
      /* non-JSON body */
    }
    return new StorageClientError(code, message, res.status);
  }
}

async function pool<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let i = 0;
  const run = async () => {
    while (i < items.length) {
      const index = i++;
      await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, run));
}

interface XhrResult {
  status: number;
  getHeader(name: string): string | null;
}

function xhrSend(o: {
  method: string;
  url: string;
  body: Blob | FormData;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  onProgress?: (p: { loaded: number; total: number }) => void;
}): Promise<XhrResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(o.method, o.url, true);
    for (const [k, v] of Object.entries(o.headers ?? {})) xhr.setRequestHeader(k, v);
    if (o.onProgress) {
      xhr.upload.onprogress = (e) => o.onProgress!({ loaded: e.loaded, total: e.total });
    }
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve({ status: xhr.status, getHeader: (n) => xhr.getResponseHeader(n) })
        : reject(new StorageClientError('upstream_error', `upload failed: ${xhr.status}`, xhr.status));
    xhr.onerror = () => reject(new StorageClientError('upstream_error', 'network error', 0));
    o.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(o.body);
  });
}

interface ResumeSession {
  key: string;
  uploadId: string;
  partSize: number;
  uploaded: Record<number, string>; // partNumber -> etag
}

function loadSession(resumeKey: string | undefined, fingerprint: string): ResumeSession | undefined {
  if (!resumeKey || typeof localStorage === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(`vela.storage.resume:${resumeKey}`);
    if (!raw) return undefined;
    const s = JSON.parse(raw) as ResumeSession & { fingerprint?: string };
    return s.fingerprint === fingerprint ? s : undefined;
  } catch {
    return undefined;
  }
}

function saveSession(resumeKey: string | undefined, fingerprint: string, s: ResumeSession): void {
  if (!resumeKey || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(`vela.storage.resume:${resumeKey}`, JSON.stringify({ ...s, fingerprint }));
  } catch {
    /* quota / private mode — resume is best-effort */
  }
}

function clearSession(resumeKey: string | undefined): void {
  if (!resumeKey || typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(`vela.storage.resume:${resumeKey}`);
  } catch {
    /* ignore */
  }
}

export class StorageClient {
  constructor(private readonly options: StorageClientOptions) {}

  async upload(file: File | Blob, opts: ClientUploadOptions = {}): Promise<UploadResult> {
    const threshold = this.options.multipartThreshold ?? DEFAULT_MULTIPART_THRESHOLD;
    const multipart =
      opts.multipart === true || (opts.multipart !== false && file.size > threshold);
    return multipart ? this.#multipartUpload(file, opts) : this.#simpleUpload(file, opts);
  }

  list(query: { prefix?: string; cursor?: string; limit?: number; delimiter?: string } = {}): Promise<ListResponse> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v != null) qs.set(k, String(v));
    return this.#json<ListResponse>('GET', `/list?${qs.toString()}`);
  }

  delete(keys: string[]): Promise<DeleteManyResult> {
    return this.#json<DeleteManyResult>('POST', '/delete', { keys } satisfies DeleteRequest);
  }

  async downloadUrl(key: string): Promise<string> {
    const r = await this.#json<{ url: string }>('POST', '/sign-download', { key });
    return r.url;
  }

  // ---- internals ----

  async #simpleUpload(file: File | Blob, opts: ClientUploadOptions): Promise<UploadResult> {
    const key = opts.key ?? fileName(file);
    const { upload } = await this.#json<SignUploadResponse>('POST', '/sign-upload', {
      key,
      contentType: opts.contentType ?? (file.type || undefined),
      size: file.size,
      metadata: opts.metadata,
    });
    if (upload.method === 'PUT') {
      await xhrSend({
        method: 'PUT',
        url: upload.url,
        body: file,
        headers: { 'content-type': file.type || 'application/octet-stream', ...upload.headers },
        signal: opts.signal,
        onProgress: opts.onProgress,
      });
    } else {
      const form = new FormData();
      for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
      form.append('file', file); // 'file' must be last for an S3/R2 POST policy
      await xhrSend({ method: 'POST', url: upload.url, body: form, signal: opts.signal, onProgress: opts.onProgress });
    }
    return { key, size: file.size, contentType: opts.contentType ?? (file.type || 'application/octet-stream') };
  }

  async #multipartUpload(file: File | Blob, opts: ClientUploadOptions): Promise<UploadResult> {
    const key = opts.key ?? fileName(file);
    const fingerprint = `${fileName(file)}:${file.size}`;
    const concurrency =
      (typeof opts.multipart === 'object' && opts.multipart.concurrency) || DEFAULT_CONCURRENCY;

    let session = loadSession(opts.resumeKey, fingerprint);
    if (!session) {
      const created = await this.#json<MultipartCreateResponse>('POST', '/multipart/create', {
        key,
        contentType: opts.contentType ?? (file.type || undefined),
        metadata: opts.metadata,
        partSize: typeof opts.multipart === 'object' ? opts.multipart.partSize : undefined,
      });
      session = { key: created.key, uploadId: created.uploadId, partSize: created.partSize, uploaded: {} };
    }

    const partSize = session.partSize;
    const count = Math.ceil(file.size / partSize) || 1;
    const loaded = new Array<number>(count + 1).fill(0);
    for (const n of Object.keys(session.uploaded)) loaded[Number(n)] = partBytes(Number(n), partSize, file.size);
    const report = () =>
      opts.onProgress?.({ loaded: loaded.reduce((a, b) => a + b, 0), total: file.size });

    const todo = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !session!.uploaded[n]);

    await pool(todo, concurrency, async (n) => {
      const blob = file.slice((n - 1) * partSize, Math.min(n * partSize, file.size));
      const signed = await this.#json<SignPartResponse>('POST', '/multipart/sign-part', {
        key: session!.key,
        uploadId: session!.uploadId,
        partNumber: n,
      });
      const res = await xhrSend({
        method: 'PUT',
        url: signed.url,
        body: blob,
        headers: signed.headers,
        signal: opts.signal,
        onProgress: (p) => {
          loaded[n] = p.loaded;
          report();
        },
      });
      const etag = res.getHeader('ETag') ?? res.getHeader('etag');
      if (!etag) {
        throw new StorageClientError(
          'invalid_request',
          'missing ETag on part upload (check bucket CORS ExposeHeaders: ETag)',
          res.status,
        );
      }
      session!.uploaded[n] = etag;
      saveSession(opts.resumeKey, fingerprint, session!);
    });

    const parts: UploadedPart[] = Object.entries(session.uploaded)
      .map(([n, etag]) => ({ partNumber: Number(n), etag }))
      .sort((a, b) => a.partNumber - b.partNumber);
    const result = await this.#json<UploadResult>('POST', '/multipart/complete', {
      key: session.key,
      uploadId: session.uploadId,
      parts,
    });
    clearSession(opts.resumeKey);
    return result;
  }

  async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const fetchImpl = this.options.fetch ?? fetch;
    const res = await fetchImpl(this.options.baseUrl + path, {
      method,
      headers: { 'content-type': 'application/json', ...((await this.options.headers?.()) ?? {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await StorageClientError.from(res);
    return (await res.json()) as T;
  }
}

function fileName(file: File | Blob): string {
  return 'name' in file && typeof file.name === 'string' && file.name ? file.name : 'upload.bin';
}

function partBytes(partNumber: number, partSize: number, total: number): number {
  const start = (partNumber - 1) * partSize;
  return Math.max(0, Math.min(partSize, total - start));
}
