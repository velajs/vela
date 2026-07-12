import { byteLengthOf } from '../../internal/body';
import { createStoredFile } from '../../internal/stored-file';
import { StorageError, type StorageErrorCode } from '../../storage.error';
import type {
  Body,
  CreateMultipartOptions,
  DownloadOptions,
  ListOptions,
  ListResult,
  MultipartUpload,
  OperationOptions,
  PartBody,
  SignedMultipartCapability,
  SignedUpload,
  SignUploadOptions,
  StorageDriver,
  StoredFile,
  UploadedPart,
  UploadOptions,
  UploadResult,
  UrlOptions,
  ByteRange,
} from '../../storage.types';
import { S3Client } from './s3-client';
import type { S3DriverOptions } from './s3.types';
import { escapeXml, tagBlocks, tagText } from './xml';

const encoder = new TextEncoder();
const DEFAULT_EXPIRES = 3600;
const DEFAULT_PART_SIZE = 5 * 1024 * 1024;

function stripQuotes(s: string | null | undefined): string | undefined {
  return s ? s.replace(/^"|"$/g, '') : undefined;
}

function parseDate(s: string | null | undefined): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

function formatRange(range: ByteRange): string {
  return `bytes=${range.start}-${range.end ?? ''}`;
}

function metaFromHeaders(headers: Headers): Record<string, string> | undefined {
  const meta: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (key.startsWith('x-amz-meta-')) meta[key.slice('x-amz-meta-'.length)] = value;
  });
  return Object.keys(meta).length ? meta : undefined;
}

function joinPublic(base: string, key: string): string {
  const enc = key.split('/').map(encodeURIComponent).join('/');
  return `${base.replace(/\/$/, '')}/${enc}`;
}

/** Map an S3 `<Code>` (and/or HTTP status) to our error taxonomy. */
function mapS3Code(code: string | undefined, status: number): StorageErrorCode {
  switch (code) {
    case 'NoSuchKey':
    case 'NoSuchUpload':
    case 'NoSuchBucket':
      return 'NotFound';
    case 'AccessDenied':
    case 'InvalidAccessKeyId':
    case 'SignatureDoesNotMatch':
    case 'AllAccessDisabled':
      return 'AccessDenied';
    case 'SlowDown':
    case 'RequestTimeout':
      return 'RateLimited';
    default:
      break;
  }
  if (status === 404) return 'NotFound';
  if (status === 403 || status === 401) return 'AccessDenied';
  if (status === 409) return 'Conflict';
  if (status === 429) return 'RateLimited';
  if (status >= 500) return 'Provider';
  if (status >= 400) return 'InvalidRequest';
  return 'Provider'; // e.g. a 200 response carrying an <Error> body
}

function toError(status: number, code: string | undefined, message: string | undefined, key?: string): StorageError {
  const mapped = mapS3Code(code, status);
  const retryable = mapped === 'Provider' || mapped === 'RateLimited' || mapped === 'Timeout' || mapped === 'Network';
  return new StorageError(mapped, message ?? code ?? `S3 error${key ? ` (${key})` : ''}`, {
    status: status >= 400 ? status : undefined,
    retryable,
    // `message`/`code` are the provider's own <Message>/<Code> — never client-safe,
    // even on a 4xx status (e.g. AccessDenied/NoSuchKey text can carry internal detail).
    internal: true,
  });
}

async function s3Error(res: Response, key?: string): Promise<StorageError> {
  let code: string | undefined;
  let message: string | undefined;
  try {
    const body = await res.text();
    code = tagText(body, 'Code');
    message = tagText(body, 'Message');
  } catch {
    /* ignore body read errors */
  }
  return toError(res.status, code, message, key);
}

function parseErrorBody(status: number, body: string, key?: string): StorageError {
  return toError(status, tagText(body, 'Code'), tagText(body, 'Message'), key);
}

/** Add `duplex: 'half'` when streaming a request body (required by fetch). */
function withDuplex(init: RequestInit, body: Body | PartBody): RequestInit {
  if (body instanceof ReadableStream) {
    return { ...init, duplex: 'half' } as RequestInit & { duplex: 'half' };
  }
  return init;
}

/** S3 / S3-compatible driver signed with aws4fetch (edge-safe). */
export function s3Driver(options: S3DriverOptions): StorageDriver {
  const client = new S3Client(options);
  const expires = options.defaultUrlExpiresIn ?? DEFAULT_EXPIRES;

  function uploadHeaders(
    opts: { contentType?: string; cacheControl?: string; metadata?: Record<string, string> } | undefined,
    unsignedPayload: boolean,
  ): Headers {
    const h = new Headers();
    if (unsignedPayload) h.set('x-amz-content-sha256', 'UNSIGNED-PAYLOAD');
    if (opts?.contentType) h.set('content-type', opts.contentType);
    if (opts?.cacheControl) h.set('cache-control', opts.cacheControl);
    if (opts?.metadata) for (const [k, v] of Object.entries(opts.metadata)) h.set(`x-amz-meta-${k}`, v);
    return h;
  }

  function multipartHandle(
    key: string,
    uploadId: string,
    createOpts?: CreateMultipartOptions,
  ): MultipartUpload {
    return {
      key,
      uploadId,
      async uploadPart(partNumber: number, part: PartBody, o?: OperationOptions) {
        const url = client.objectUrl(key, { partNumber: String(partNumber), uploadId });
        const res = await client.send(
          url,
          withDuplex(
            {
              method: 'PUT',
              headers: new Headers({ 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' }),
              body: part as BodyInit,
              signal: o?.signal,
            },
            part,
          ),
        );
        if (!res.ok) throw await s3Error(res, key);
        const etag = res.headers.get('etag');
        if (!etag) throw new StorageError('Provider', `missing ETag for part ${partNumber}`);
        return { partNumber, etag };
      },
      async complete(parts: UploadedPart[], o?: OperationOptions) {
        const xml =
          '<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>' +
          [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map(
              (p) =>
                `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`,
            )
            .join('') +
          '</CompleteMultipartUpload>';
        const res = await client.send(client.objectUrl(key, { uploadId }), {
          method: 'POST',
          headers: new Headers({ 'content-type': 'application/xml' }),
          body: encoder.encode(xml),
          signal: o?.signal,
        });
        const body = await res.text();
        if (!res.ok || body.includes('<Error')) throw parseErrorBody(res.status, body, key);
        return {
          key,
          size: 0,
          contentType: createOpts?.contentType ?? 'application/octet-stream',
          etag: stripQuotes(tagText(body, 'ETag')),
        };
      },
      async abort(o?: OperationOptions) {
        const res = await client.send(client.objectUrl(key, { uploadId }), {
          method: 'DELETE',
          signal: o?.signal,
        });
        if (!res.ok && res.status !== 404) throw await s3Error(res, key);
      },
      async listParts(o?: OperationOptions) {
        const res = await client.send(client.objectUrl(key, { uploadId }), {
          method: 'GET',
          signal: o?.signal,
        });
        const xml = await res.text();
        if (!res.ok) throw parseErrorBody(res.status, xml, key);
        return tagBlocks(xml, 'Part').map((b) => ({
          partNumber: Number(tagText(b, 'PartNumber') ?? 0),
          etag: stripQuotes(tagText(b, 'ETag')) ?? '',
          size: Number(tagText(b, 'Size') ?? 0),
        }));
      },
    };
  }

  const signedMultipart: SignedMultipartCapability = {
    async create(key, o) {
      const res = await client.send(client.objectUrl(key, { uploads: '' }), {
        method: 'POST',
        headers: uploadHeaders({ contentType: o.contentType, metadata: o.metadata }, false),
      });
      const xml = await res.text();
      if (!res.ok) throw parseErrorBody(res.status, xml, key);
      const uploadId = tagText(xml, 'UploadId');
      if (!uploadId) throw new StorageError('Parse', 'missing UploadId');
      return { uploadId, partSize: o.partSize ?? DEFAULT_PART_SIZE };
    },
    async signPart(key, uploadId, partNumber, o) {
      const url = await client.presign(key, 'PUT', o?.expiresIn ?? expires, {
        partNumber: String(partNumber),
        uploadId,
      });
      return { url };
    },
    complete(key, uploadId, parts) {
      return multipartHandle(key, uploadId).complete(parts);
    },
    abort(key, uploadId) {
      return multipartHandle(key, uploadId).abort();
    },
  };

  return {
    name: options.name ?? 's3',
    raw: client,
    supportsRange: true,
    supportsDelimiter: true,
    supportsMetadata: true,
    supportsCacheControl: true,
    supportsServerSideCopy: true,
    reportsUploadProgress: false,
    signedUrl: { supported: true, upload: true },

    async upload(key: string, body: Body, opts?: UploadOptions): Promise<UploadResult> {
      const size = byteLengthOf(body) ?? 0;
      const res = await client.send(
        client.objectUrl(key),
        withDuplex(
          { method: 'PUT', headers: uploadHeaders(opts, true), body: body as BodyInit, signal: opts?.signal },
          body,
        ),
      );
      if (!res.ok) throw await s3Error(res, key);
      return {
        key,
        size,
        contentType: opts?.contentType ?? 'application/octet-stream',
        etag: stripQuotes(res.headers.get('etag')),
        lastModified: parseDate(res.headers.get('last-modified')),
      };
    },

    async download(key: string, opts?: DownloadOptions): Promise<StoredFile> {
      const headers = new Headers();
      if (opts?.range) headers.set('Range', formatRange(opts.range));
      const res = await client.send(client.objectUrl(key), {
        method: 'GET',
        headers,
        signal: opts?.signal,
      });
      if (!res.ok || !res.body) {
        if (res.status === 404) throw new StorageError('NotFound', `not found: ${key}`, { status: 404 });
        throw await s3Error(res, key);
      }
      return createStoredFile(
        {
          key,
          size: Number(res.headers.get('content-length') ?? 0),
          type: res.headers.get('content-type') ?? 'application/octet-stream',
          etag: stripQuotes(res.headers.get('etag')),
          lastModified: parseDate(res.headers.get('last-modified')),
          metadata: metaFromHeaders(res.headers),
        },
        { kind: 'stream', stream: res.body },
      );
    },

    async head(key: string, opts?: OperationOptions): Promise<StoredFile> {
      const res = await client.send(client.objectUrl(key), { method: 'HEAD', signal: opts?.signal });
      if (!res.ok) {
        if (res.status === 404) throw new StorageError('NotFound', `not found: ${key}`, { status: 404 });
        throw await s3Error(res, key);
      }
      return createStoredFile(
        {
          key,
          size: Number(res.headers.get('content-length') ?? 0),
          type: res.headers.get('content-type') ?? 'application/octet-stream',
          etag: stripQuotes(res.headers.get('etag')),
          lastModified: parseDate(res.headers.get('last-modified')),
          metadata: metaFromHeaders(res.headers),
        },
        { kind: 'lazy', fetch: () => client.send(client.objectUrl(key), { method: 'GET' }) },
      );
    },

    async exists(key: string, opts?: OperationOptions): Promise<boolean> {
      const res = await client.send(client.objectUrl(key), { method: 'HEAD', signal: opts?.signal });
      if (res.status === 404) return false;
      if (!res.ok) throw await s3Error(res, key);
      return true;
    },

    async delete(key: string, opts?: OperationOptions): Promise<void> {
      const res = await client.send(client.objectUrl(key), { method: 'DELETE', signal: opts?.signal });
      if (!res.ok && res.status !== 404) throw await s3Error(res, key);
    },

    async copy(from: string, to: string, opts?: OperationOptions): Promise<void> {
      const source = `/${client.bucket}/${from.split('/').map(encodeURIComponent).join('/')}`;
      const res = await client.send(client.objectUrl(to), {
        method: 'PUT',
        headers: new Headers({ 'x-amz-copy-source': source }),
        signal: opts?.signal,
      });
      const body = await res.text();
      if (!res.ok || body.includes('<Error')) throw parseErrorBody(res.status, body, to);
    },

    async list(opts?: ListOptions): Promise<ListResult> {
      const query: Record<string, string> = { 'list-type': '2' };
      if (opts?.prefix) query.prefix = opts.prefix;
      if (opts?.delimiter) query.delimiter = opts.delimiter;
      if (opts?.cursor) query['continuation-token'] = opts.cursor;
      if (opts?.limit) query['max-keys'] = String(opts.limit);
      const res = await client.send(client.objectUrl('', query), { method: 'GET', signal: opts?.signal });
      const xml = await res.text();
      if (!res.ok) throw parseErrorBody(res.status, xml);

      const items = tagBlocks(xml, 'Contents').map((b) => {
        const k = tagText(b, 'Key') ?? '';
        return createStoredFile(
          {
            key: k,
            size: Number(tagText(b, 'Size') ?? 0),
            type: 'application/octet-stream',
            etag: stripQuotes(tagText(b, 'ETag')),
            lastModified: parseDate(tagText(b, 'LastModified')),
          },
          { kind: 'lazy', fetch: () => client.send(client.objectUrl(k), { method: 'GET' }) },
        );
      });
      const prefixes = tagBlocks(xml, 'CommonPrefixes')
        .map((b) => tagText(b, 'Prefix'))
        .filter((p): p is string => !!p);
      const cursor = tagText(xml, 'IsTruncated') === 'true' ? tagText(xml, 'NextContinuationToken') : undefined;
      return { items, prefixes: prefixes.length ? prefixes : undefined, cursor };
    },

    async url(key: string, opts?: UrlOptions): Promise<string> {
      const forceSign = !!opts?.responseContentDisposition;
      if (options.publicBaseUrl && !forceSign) return joinPublic(options.publicBaseUrl, key);
      const query = opts?.responseContentDisposition
        ? { 'response-content-disposition': opts.responseContentDisposition }
        : undefined;
      return client.presign(key, 'GET', opts?.expiresIn ?? expires, query);
    },

    async signedUploadUrl(key: string, opts: SignUploadOptions): Promise<SignedUpload> {
      if (opts.maxSize != null || opts.minSize != null) {
        const { url, fields } = await client.signPostPolicy(key, {
          expiresIn: opts.expiresIn,
          contentType: opts.contentType,
          maxSize: opts.maxSize,
          minSize: opts.minSize,
        });
        return { method: 'POST', url, fields };
      }
      const url = await client.presign(key, 'PUT', opts.expiresIn);
      return {
        method: 'PUT',
        url,
        headers: opts.contentType ? { 'content-type': opts.contentType } : undefined,
      };
    },

    async createMultipartUpload(
      key: string,
      opts?: CreateMultipartOptions,
    ): Promise<MultipartUpload> {
      const res = await client.send(client.objectUrl(key, { uploads: '' }), {
        method: 'POST',
        headers: uploadHeaders(opts, false),
        signal: opts?.signal,
      });
      const xml = await res.text();
      if (!res.ok) throw parseErrorBody(res.status, xml, key);
      const uploadId = tagText(xml, 'UploadId');
      if (!uploadId) throw new StorageError('Parse', 'missing UploadId');
      return multipartHandle(key, uploadId, opts);
    },

    resumeMultipartUpload(key: string, uploadId: string): MultipartUpload {
      return multipartHandle(key, uploadId);
    },

    signedMultipart,
  };
}
