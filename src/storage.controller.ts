import { Controller, Get, Inject, Injectable, Post, Req, type Token, type Type } from '@velajs/vela';
import type { Context } from 'hono';
import { sanitizeKey } from './object-key';
import { StorageError } from './storage.error';
import type { StorageService } from './storage.service';
import type { StorageAction, StorageAuthorizer, StorageAuthResult } from './http/authorizer.types';
import {
  clampExpiry,
  dispositionHeader,
  mapError,
  parseRange,
  serializeStored,
} from './http/http-helpers';
import type {
  DeleteRequest,
  ListResponse,
  MultipartAbortRequest,
  MultipartCompleteRequest,
  MultipartCreateRequest,
  SignPartRequest,
  SignUploadRequest,
} from './http/protocol.types';

export interface ResolvedHttpOptions {
  driverName: string;
  authorize?: StorageAuthorizer;
  defaultPolicy: 'deny' | 'allow';
  download: 'redirect' | 'proxy';
  defaultExpiresIn: number;
  maxExpiresIn: number;
  maxUploadSize?: number;
  maxListLimit: number;
  deleteConcurrency: number;
}

/**
 * Build a vela controller exposing presigned/multipart upload + download
 * endpoints for one bucket. Factory-decorated (like better-auth's catch-all)
 * so `basePath` bakes in at decoration time. Consumes the {@link StorageService}
 * facade so gating/retry/prefix apply uniformly on the HTTP path.
 */
export function createStorageController(
  basePath: string,
  serviceToken: Token<StorageService>,
  http: ResolvedHttpOptions,
): Type {
  @Controller(basePath)
  @Injectable()
  class StorageController {
    constructor(@Inject(serviceToken) private readonly svc: StorageService) {}

    private get storage() {
      return this.svc.storage;
    }

    private async authorize(c: Context, action: StorageAction): Promise<StorageAuthResult> {
      if (!http.authorize) {
        if (http.defaultPolicy === 'allow') return {};
        throw new StorageError('AccessDenied', 'storage: no authorizer configured (default deny)');
      }
      const res = await http.authorize(action, { req: c.req.raw, ctx: c, driver: http.driverName });
      if (res === false) throw new StorageError('AccessDenied', 'not allowed');
      if (res === true) return {};
      return res;
    }

    private fail(c: Context, e: unknown): Response {
      const err = e instanceof StorageError ? e : StorageError.wrap(e);
      const { wire, status } = mapError(err.code);
      // Never echo a provider/transport/wrapped message to the client: those are
      // flagged `internal` (driver <Message>/<Code>, StorageError.wrap, fromStatus)
      // and can carry host/bucket/credential detail — including on a 4xx status.
      // Redact internal errors at any status, plus all upstream (5xx) responses;
      // 4xx codes with an author-vouched message echo it.
      const message = err.internal || status >= 500 ? 'storage backend error' : err.message;
      return c.json({ error: { code: wire, message } }, status as never);
    }

    @Post('/sign-upload')
    async signUpload(@Req() c: Context): Promise<Response> {
      try {
        const b = (await c.req.json()) as SignUploadRequest;
        const ov = await this.authorize(c, {
          type: 'sign-upload',
          key: b.key,
          contentType: b.contentType,
          size: b.size,
        });
        const key = sanitizeKey(ov.key ?? b.key);
        const upload = await this.storage.signedUploadUrl(key, {
          expiresIn: clampExpiry(ov.expiresIn ?? b.expiresIn, http.defaultExpiresIn, http.maxExpiresIn),
          contentType: b.contentType,
          maxSize: ov.maxSize ?? http.maxUploadSize,
        });
        return c.json({ key, upload });
      } catch (e) {
        return this.fail(c, e);
      }
    }

    @Post('/multipart/create')
    async multipartCreate(@Req() c: Context): Promise<Response> {
      try {
        const b = (await c.req.json()) as MultipartCreateRequest;
        const ov = await this.authorize(c, { type: 'multipart-create', key: b.key, contentType: b.contentType });
        const key = sanitizeKey(ov.key ?? b.key);
        const sm = this.storage.signedMultipart;
        if (!sm) throw new StorageError('Unsupported', 'presigned multipart not supported');
        const created = await sm.create(key, {
          contentType: b.contentType,
          metadata: ov.metadata ?? b.metadata,
          partSize: b.partSize,
        });
        return c.json({ key, uploadId: created.uploadId, partSize: created.partSize });
      } catch (e) {
        return this.fail(c, e);
      }
    }

    @Post('/multipart/sign-part')
    async multipartSignPart(@Req() c: Context): Promise<Response> {
      try {
        const b = (await c.req.json()) as SignPartRequest;
        const ov = await this.authorize(c, {
          type: 'multipart-sign-part',
          key: b.key,
          uploadId: b.uploadId,
          partNumber: b.partNumber,
        });
        const key = sanitizeKey(ov.key ?? b.key);
        const sm = this.storage.signedMultipart;
        if (!sm) throw new StorageError('Unsupported', 'presigned multipart not supported');
        const part = await sm.signPart(key, b.uploadId, b.partNumber, {
          expiresIn: clampExpiry(ov.expiresIn, http.defaultExpiresIn, http.maxExpiresIn),
        });
        return c.json({ partNumber: b.partNumber, method: 'PUT', url: part.url, headers: part.headers });
      } catch (e) {
        return this.fail(c, e);
      }
    }

    @Post('/multipart/complete')
    async multipartComplete(@Req() c: Context): Promise<Response> {
      try {
        const b = (await c.req.json()) as MultipartCompleteRequest;
        const ov = await this.authorize(c, { type: 'multipart-complete', key: b.key, uploadId: b.uploadId });
        const key = sanitizeKey(ov.key ?? b.key);
        const sm = this.storage.signedMultipart;
        if (!sm) throw new StorageError('Unsupported', 'presigned multipart not supported');
        return c.json(await sm.complete(key, b.uploadId, b.parts));
      } catch (e) {
        return this.fail(c, e);
      }
    }

    @Post('/multipart/abort')
    async multipartAbort(@Req() c: Context): Promise<Response> {
      try {
        const b = (await c.req.json()) as MultipartAbortRequest;
        const ov = await this.authorize(c, { type: 'multipart-abort', key: b.key, uploadId: b.uploadId });
        const key = sanitizeKey(ov.key ?? b.key);
        const sm = this.storage.signedMultipart;
        if (!sm) throw new StorageError('Unsupported', 'presigned multipart not supported');
        await sm.abort(key, b.uploadId);
        return c.json({ ok: true });
      } catch (e) {
        return this.fail(c, e);
      }
    }

    @Get('/list')
    async list(@Req() c: Context): Promise<Response> {
      try {
        const prefix = c.req.query('prefix');
        const ov = await this.authorize(c, { type: 'list', prefix });
        const limit = c.req.query('limit');
        const res = await this.storage.list({
          prefix: ov.prefix ?? prefix,
          cursor: c.req.query('cursor'),
          delimiter: c.req.query('delimiter'),
          limit: limit ? Math.min(Number(limit), http.maxListLimit) : undefined,
        });
        return c.json({
          items: res.items.map(serializeStored),
          prefixes: res.prefixes,
          cursor: res.cursor,
        } satisfies ListResponse);
      } catch (e) {
        return this.fail(c, e);
      }
    }

    @Get('/head')
    async head(@Req() c: Context): Promise<Response> {
      try {
        const key = sanitizeKey(c.req.query('key') ?? '');
        const ov = await this.authorize(c, { type: 'head', key });
        const file = await this.storage.head(sanitizeKey(ov.key ?? key));
        return c.json(serializeStored(file));
      } catch (e) {
        return this.fail(c, e);
      }
    }

    @Post('/delete')
    async delete(@Req() c: Context): Promise<Response> {
      try {
        const b = (await c.req.json()) as DeleteRequest;
        const keys = b.keys.map((k) => sanitizeKey(k));
        const ov = await this.authorize(c, { type: 'delete', keys });
        const effective = (ov.keys ?? keys).map((k) => sanitizeKey(k));
        return c.json(await this.storage.delete(effective, { concurrency: http.deleteConcurrency }));
      } catch (e) {
        return this.fail(c, e);
      }
    }

    @Get('/download')
    async download(@Req() c: Context): Promise<Response> {
      try {
        const key = sanitizeKey(c.req.query('key') ?? '');
        const disp = c.req.query('disposition');
        const ov = await this.authorize(c, { type: 'download', key });
        const ekey = sanitizeKey(ov.key ?? key);
        const name = ekey.slice(ekey.lastIndexOf('/') + 1);

        if (http.download === 'redirect' && this.storage.capabilities.signedUrl.supported) {
          const url = await this.storage.url(ekey, {
            expiresIn: clampExpiry(ov.expiresIn, http.defaultExpiresIn, http.maxExpiresIn),
            responseContentDisposition: dispositionHeader(disp, name),
          });
          return c.redirect(url, 302);
        }

        const range = parseRange(c.req.header('range'));
        const file = await this.storage.download(ekey, range ? { range } : undefined);
        const headers = new Headers({
          'content-type': file.type,
          'content-length': String(file.size),
          'content-disposition': dispositionHeader(disp, file.name),
        });
        if (file.etag) headers.set('etag', file.etag);
        if (range) {
          headers.set('content-range', `bytes ${range.start}-${range.start + file.size - 1}/*`);
          return new Response(file.stream(), { status: 206, headers });
        }
        return new Response(file.stream(), { status: 200, headers });
      } catch (e) {
        return this.fail(c, e);
      }
    }

    @Post('/sign-download')
    async signDownload(@Req() c: Context): Promise<Response> {
      try {
        const b = (await c.req.json()) as { key: string; expiresIn?: number };
        const ov = await this.authorize(c, { type: 'download', key: b.key });
        const key = sanitizeKey(ov.key ?? b.key);
        const expiresIn = clampExpiry(ov.expiresIn ?? b.expiresIn, http.defaultExpiresIn, http.maxExpiresIn);
        const url = await this.storage.url(key, { expiresIn });
        return c.json({ url, expiresAt: Date.now() + expiresIn * 1000 });
      } catch (e) {
        return this.fail(c, e);
      }
    }
  }

  return StorageController;
}
