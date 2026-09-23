import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  InjectionToken,
  Post,
  readJsonBody,
  Req,
  UnsupportedMediaTypeException,
  type TypedToken,
  type Type,
} from '@velajs/vela';
import type { Context } from 'hono';
import { sanitizeKey } from './object-key';
import { StorageError } from './storage.error';
import type { StorageService } from './storage.service';
import type { StoredFile } from './storage.types';
import type { StorageAction, StorageAuthorizer, StorageAuthResult } from './http/authorizer.types';
import {
  clampExpiry,
  dispositionHeader,
  mapError,
  parseRange,
  serializeStored,
} from './http/http-helpers';
import {
  createMultipartGrant,
  type MultipartGrantClaims,
  validateMultipartGrantSecret,
  verifyMultipartGrant,
} from './http/multipart-grant';
import type {
  DeleteRequest,
  ListResponse,
  MultipartAbortRequest,
  MultipartCompleteRequest,
  MultipartCreateRequest,
  SignPartRequest,
  SignUploadRequest,
} from './http/protocol.types';

// Browser-direct multipart uploads never write to a caller-visible key until
// the completed object has passed the size checks bound into its signed grant.
// The HTTP surface reserves this namespace so quarantined objects cannot be
// read, listed, signed, or deleted through user-key endpoints.
const INTERNAL_KEY_ROOT = '__vela_internal__';
const MULTIPART_STAGING_PREFIX = `${INTERNAL_KEY_ROOT}/multipart/`;

export interface ResolvedHttpOptions {
  driverName: string;
  authorize?: StorageAuthorizer;
  download: 'redirect' | 'proxy';
  defaultExpiresIn: number;
  maxExpiresIn: number;
  maxUploadSize?: number;
  multipartGrantSecret?: string | Uint8Array;
  maxMultipartParts: number;
  maxListLimit: number;
  deleteConcurrency: number;
}

/** Values each application resolves through DI and the controller reads per request. */
export interface StorageControllerOptions {
  /** The multipart grant secret, when it comes from a `forRootAsync` factory. */
  multipartGrantSecret?: () => string | Uint8Array | undefined;
}

const NO_CONTROLLER_OPTIONS = new InjectionToken<StorageControllerOptions>(
  '@velajs/storage:controller-options',
  { factory: () => ({}) },
);

/**
 * Build a vela controller exposing presigned/multipart upload + download
 * endpoints for one bucket. Factory-decorated (like better-auth's catch-all)
 * so `basePath` bakes in at decoration time. Consumes the {@link StorageService}
 * facade so gating/retry/prefix apply uniformly on the HTTP path. `optionsToken`
 * supplies values resolved per application, such as a multipart grant secret
 * that takes precedence over `http.multipartGrantSecret`.
 */
export function createStorageController<Options extends StorageControllerOptions>(
  basePath: string,
  serviceToken: TypedToken<StorageService>,
  http: ResolvedHttpOptions,
  optionsToken?: TypedToken<Options>,
): Type {
  @Controller(basePath)
  class StorageController {
    constructor(
      @Inject(serviceToken) private readonly svc: StorageService,
      @Inject(optionsToken ?? NO_CONTROLLER_OPTIONS)
      private readonly options: StorageControllerOptions,
    ) {}

    private get storage() {
      return this.svc.storage;
    }

    private async authorize(c: Context, action: StorageAction): Promise<StorageAuthResult> {
      if (!http.authorize) {
        throw new StorageError('AccessDenied', 'storage: no authorizer configured (default deny)');
      }
      const res = await http.authorize(action, { req: c.req.raw, ctx: c, driver: http.driverName });
      if (res === false) throw new StorageError('AccessDenied', 'not allowed');
      if (res === true) return {};
      if (typeof res !== 'object' || res === null || Array.isArray(res)) {
        throw new StorageError('AccessDenied', 'storage authorizer returned an invalid result');
      }
      return res;
    }

    /**
     * The request's JSON object body. Hono's `c.req.json()` ignores
     * Content-Type, so a cross-site `text/plain` POST, which needs no CORS
     * preflight, would reach the handler; `readJsonBody` refuses it with 415.
     */
    private async body<T extends object>(c: Context): Promise<T> {
      let body: unknown;
      try {
        body = await readJsonBody(c);
      } catch (error) {
        if (error instanceof BadRequestException) {
          throw new StorageError('InvalidRequest', 'request body is not valid JSON');
        }
        throw error;
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new StorageError('InvalidRequest', 'request body must be a JSON object');
      }
      return body as T;
    }

    private fail(c: Context, e: unknown): Response {
      if (e instanceof UnsupportedMediaTypeException) {
        return c.json({ error: { code: 'invalid_request', message: e.message } }, 415);
      }
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

    private multipartSecret(): string | Uint8Array {
      const secret = this.options.multipartGrantSecret?.() ?? http.multipartGrantSecret;
      if (secret === undefined) {
        throw new StorageError(
          'AccessDenied',
          'storage: multipartGrantSecret is required for browser-direct multipart uploads',
        );
      }
      validateMultipartGrantSecret(secret);
      return secret;
    }

    private actor(result: StorageAuthResult): string {
      if (
        typeof result.actorId !== 'string' ||
        result.actorId.trim().length === 0 ||
        new TextEncoder().encode(result.actorId).byteLength > 512
      ) {
        throw new StorageError(
          'AccessDenied',
          'storage: multipart authorization must return a trusted actorId',
        );
      }
      return result.actorId;
    }

    private userKey(value: string): string {
      const key = sanitizeKey(value);
      if (key === INTERNAL_KEY_ROOT || key.startsWith(`${INTERNAL_KEY_ROOT}/`)) {
        throw new StorageError('InvalidKey', 'the requested object key is reserved');
      }
      return key;
    }

    private userPrefix(value: string | undefined): string | undefined {
      if (value === undefined || value === '') return value;
      const prefix = this.userKey(value);
      return prefix;
    }

    private stagingKey(): string {
      return `${MULTIPART_STAGING_PREFIX}${crypto.randomUUID()}`;
    }

    private checkedStagingKey(value: string): string {
      const key = sanitizeKey(value);
      if (!key.startsWith(MULTIPART_STAGING_PREFIX)) {
        throw new StorageError('AccessDenied', 'invalid multipart staging binding');
      }
      return key;
    }

    /** Best-effort bounded cleanup; a failure leaves only an inaccessible quarantine key. */
    private async cleanupStaging(key: string): Promise<void> {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await this.storage.delete(key);
          return;
        } catch {
          // Retry transient provider failures without ever exposing the final key.
        }
      }
    }

    private async multipartClaims(
      grant: string,
      expected: { key: string; uploadId: string; actorId: string },
    ): Promise<MultipartGrantClaims> {
      const claims = await verifyMultipartGrant(this.multipartSecret(), grant);
      if (
        claims.key !== expected.key ||
        claims.uploadId !== expected.uploadId ||
        claims.actorId !== expected.actorId
      ) {
        throw new StorageError('AccessDenied', 'multipart upload grant binding mismatch');
      }
      this.checkedStagingKey(claims.stagingKey);
      return claims;
    }

    private uploadSizeLimit(authorized: number | undefined): number | undefined {
      if (authorized !== undefined && (!Number.isSafeInteger(authorized) || authorized <= 0)) {
        throw new StorageError('InvalidRequest', 'authorized upload size limit is invalid');
      }
      if (http.maxUploadSize === undefined) return authorized;
      return authorized === undefined
        ? http.maxUploadSize
        : Math.min(authorized, http.maxUploadSize);
    }

    @Post('/sign-upload')
    async signUpload(@Req() c: Context): Promise<Response> {
      try {
        const b = await this.body<SignUploadRequest>(c);
        const ov = await this.authorize(c, {
          type: 'sign-upload',
          key: b.key,
          contentType: b.contentType,
          size: b.size,
        });
        const key = this.userKey(ov.key ?? b.key);
        if (b.size !== undefined && (!Number.isSafeInteger(b.size) || b.size <= 0)) {
          throw new StorageError('InvalidRequest', 'upload size must be a positive integer');
        }
        const maxSize = this.uploadSizeLimit(ov.maxSize);
        if (maxSize !== undefined && b.size !== undefined && b.size > maxSize) {
          throw new StorageError('InvalidRequest', 'upload exceeds the configured size limit');
        }
        const upload = await this.storage.signedUploadUrl(key, {
          expiresIn: clampExpiry(
            ov.expiresIn ?? b.expiresIn,
            http.defaultExpiresIn,
            http.maxExpiresIn,
          ),
          contentType: b.contentType,
          maxSize,
        });
        return c.json({ key, upload });
      } catch (e) {
        return this.fail(c, e);
      }
    }

    @Post('/multipart/create')
    async multipartCreate(@Req() c: Context): Promise<Response> {
      try {
        const b = await this.body<MultipartCreateRequest>(c);
        const ov = await this.authorize(c, {
          type: 'multipart-create',
          key: b.key,
          contentType: b.contentType,
          size: b.size,
        });
        const key = this.userKey(ov.key ?? b.key);
        const stagingKey = this.stagingKey();
        const actorId = this.actor(ov);
        const grantSecret = this.multipartSecret();
        if (!Number.isSafeInteger(b.size) || b.size <= 0) {
          throw new StorageError('InvalidRequest', 'multipart size must be a positive integer');
        }
        const maxSize = this.uploadSizeLimit(ov.maxSize);
        if (maxSize !== undefined && b.size > maxSize) {
          throw new StorageError('InvalidRequest', 'multipart upload exceeds the size limit');
        }
        const sm = this.storage.signedMultipart;
        if (!sm) throw new StorageError('Unsupported', 'presigned multipart not supported');
        if (b.partSize !== undefined && (!Number.isSafeInteger(b.partSize) || b.partSize <= 0)) {
          throw new StorageError('InvalidRequest', 'multipart partSize must be a positive integer');
        }
        const expiresIn = clampExpiry(
          ov.expiresIn ?? b.expiresIn,
          http.defaultExpiresIn,
          http.maxExpiresIn,
        );
        const expiresAtMs = Date.now() + expiresIn * 1000;
        if (!Number.isSafeInteger(expiresAtMs)) {
          throw new StorageError('InvalidRequest', 'multipart expiry is outside the safe range');
        }
        const created = await sm.create(stagingKey, {
          contentType: b.contentType,
          metadata: ov.metadata ?? b.metadata,
          partSize: b.partSize,
        });
        if (
          typeof created.uploadId !== 'string' ||
          created.uploadId.length === 0 ||
          new TextEncoder().encode(created.uploadId).byteLength > 1024 ||
          !Number.isSafeInteger(created.partSize) ||
          created.partSize <= 0
        ) {
          if (typeof created.uploadId === 'string') {
            await sm.abort(stagingKey, created.uploadId).catch(() => {});
          }
          throw new StorageError(
            'Provider',
            'multipart provider returned invalid upload metadata',
            { internal: true },
          );
        }
        const partCount = Math.ceil(b.size / created.partSize);
        if (partCount > http.maxMultipartParts) {
          await sm.abort(stagingKey, created.uploadId).catch(() => {});
          throw new StorageError('InvalidRequest', 'multipart upload exceeds the part-count limit');
        }
        let grant: string;
        try {
          grant = await createMultipartGrant(grantSecret, {
            v: 2,
            actorId,
            key,
            stagingKey,
            uploadId: created.uploadId,
            expectedBytes: b.size,
            partCount,
            expiresAtMs,
          });
        } catch (error) {
          await sm.abort(stagingKey, created.uploadId).catch(() => {});
          throw error;
        }
        return c.json({
          key,
          uploadId: created.uploadId,
          partSize: created.partSize,
          partCount,
          expiresAtMs,
          grant,
        });
      } catch (e) {
        return this.fail(c, e);
      }
    }

    @Post('/multipart/sign-part')
    async multipartSignPart(@Req() c: Context): Promise<Response> {
      try {
        const b = await this.body<SignPartRequest>(c);
        const ov = await this.authorize(c, {
          type: 'multipart-sign-part',
          key: b.key,
          uploadId: b.uploadId,
          partNumber: b.partNumber,
        });
        const key = this.userKey(ov.key ?? b.key);
        const claims = await this.multipartClaims(b.grant, {
          key,
          uploadId: b.uploadId,
          actorId: this.actor(ov),
        });
        if (
          !Number.isSafeInteger(b.partNumber) ||
          b.partNumber < 1 ||
          b.partNumber > claims.partCount
        ) {
          throw new StorageError('InvalidRequest', 'multipart part number is outside the grant');
        }
        const sm = this.storage.signedMultipart;
        if (!sm) throw new StorageError('Unsupported', 'presigned multipart not supported');
        const remainingSeconds = Math.floor((claims.expiresAtMs - Date.now()) / 1000);
        if (remainingSeconds <= 0) {
          throw new StorageError('AccessDenied', 'multipart upload grant is expired');
        }
        const part = await sm.signPart(claims.stagingKey, b.uploadId, b.partNumber, {
          expiresIn: Math.min(
            clampExpiry(ov.expiresIn, http.defaultExpiresIn, http.maxExpiresIn),
            remainingSeconds,
          ),
        });
        return c.json({
          partNumber: b.partNumber,
          method: 'PUT',
          url: part.url,
          headers: part.headers,
        });
      } catch (e) {
        return this.fail(c, e);
      }
    }

    @Post('/multipart/complete')
    async multipartComplete(@Req() c: Context): Promise<Response> {
      try {
        const b = await this.body<MultipartCompleteRequest>(c);
        const ov = await this.authorize(c, {
          type: 'multipart-complete',
          key: b.key,
          uploadId: b.uploadId,
        });
        const key = this.userKey(ov.key ?? b.key);
        const claims = await this.multipartClaims(b.grant, {
          key,
          uploadId: b.uploadId,
          actorId: this.actor(ov),
        });
        if (!Array.isArray(b.parts) || b.parts.length !== claims.partCount) {
          throw new StorageError('InvalidRequest', 'multipart completion has the wrong part count');
        }
        const seen = new Set<number>();
        for (const part of b.parts) {
          if (
            !Number.isSafeInteger(part.partNumber) ||
            part.partNumber < 1 ||
            part.partNumber > claims.partCount ||
            seen.has(part.partNumber) ||
            typeof part.etag !== 'string' ||
            part.etag.length === 0 ||
            part.etag.length > 1024
          ) {
            throw new StorageError('InvalidRequest', 'multipart completion contains invalid parts');
          }
          seen.add(part.partNumber);
        }
        const sm = this.storage.signedMultipart;
        if (!sm) throw new StorageError('Unsupported', 'presigned multipart not supported');
        let stored: StoredFile;
        try {
          await sm.complete(claims.stagingKey, b.uploadId, b.parts);
          stored = await this.storage.head(claims.stagingKey);
          const tooLarge = http.maxUploadSize !== undefined && stored.size > http.maxUploadSize;
          if (tooLarge || stored.size !== claims.expectedBytes) {
            throw new StorageError(
              'InvalidRequest',
              tooLarge
                ? 'completed multipart object exceeds the size limit'
                : 'completed multipart object size does not match the grant',
            );
          }
          await this.storage.move(claims.stagingKey, key);
        } catch (error) {
          await this.cleanupStaging(claims.stagingKey);
          throw error;
        }
        return c.json({
          key,
          size: stored.size,
          contentType: stored.type,
          etag: stored.etag,
          lastModified: stored.lastModified,
        });
      } catch (e) {
        return this.fail(c, e);
      }
    }

    @Post('/multipart/abort')
    async multipartAbort(@Req() c: Context): Promise<Response> {
      try {
        const b = await this.body<MultipartAbortRequest>(c);
        const ov = await this.authorize(c, {
          type: 'multipart-abort',
          key: b.key,
          uploadId: b.uploadId,
        });
        const key = this.userKey(ov.key ?? b.key);
        const claims = await this.multipartClaims(b.grant, {
          key,
          uploadId: b.uploadId,
          actorId: this.actor(ov),
        });
        const sm = this.storage.signedMultipart;
        if (!sm) throw new StorageError('Unsupported', 'presigned multipart not supported');
        await sm.abort(claims.stagingKey, b.uploadId);
        await this.cleanupStaging(claims.stagingKey);
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
        let parsedLimit: number | undefined;
        if (limit !== undefined) {
          parsedLimit = Number(limit);
          if (!Number.isSafeInteger(parsedLimit) || parsedLimit <= 0) {
            throw new StorageError('InvalidRequest', 'list limit must be a positive integer');
          }
        }
        const res = await this.storage.list({
          prefix: this.userPrefix(ov.prefix ?? prefix),
          cursor: c.req.query('cursor'),
          delimiter: c.req.query('delimiter'),
          limit: parsedLimit === undefined ? undefined : Math.min(parsedLimit, http.maxListLimit),
        });
        return c.json({
          items: res.items
            .filter((item) => !item.key.startsWith(`${INTERNAL_KEY_ROOT}/`))
            .map(serializeStored),
          prefixes: res.prefixes?.filter(
            (listedPrefix) => !listedPrefix.startsWith(`${INTERNAL_KEY_ROOT}/`),
          ),
          cursor: res.cursor,
        } satisfies ListResponse);
      } catch (e) {
        return this.fail(c, e);
      }
    }

    @Get('/head')
    async head(@Req() c: Context): Promise<Response> {
      try {
        const key = this.userKey(c.req.query('key') ?? '');
        const ov = await this.authorize(c, { type: 'head', key });
        const file = await this.storage.head(this.userKey(ov.key ?? key));
        return c.json(serializeStored(file));
      } catch (e) {
        return this.fail(c, e);
      }
    }

    @Post('/delete')
    async delete(@Req() c: Context): Promise<Response> {
      try {
        const b = await this.body<DeleteRequest>(c);
        const keys = b.keys.map((k) => this.userKey(k));
        const ov = await this.authorize(c, { type: 'delete', keys });
        const effective = (ov.keys ?? keys).map((k) => this.userKey(k));
        return c.json(
          await this.storage.delete(effective, { concurrency: http.deleteConcurrency }),
        );
      } catch (e) {
        return this.fail(c, e);
      }
    }

    @Get('/download')
    async download(@Req() c: Context): Promise<Response> {
      try {
        const key = this.userKey(c.req.query('key') ?? '');
        const disp = c.req.query('disposition');
        const ov = await this.authorize(c, { type: 'download', key });
        const ekey = this.userKey(ov.key ?? key);
        const name = ekey.slice(ekey.lastIndexOf('/') + 1);

        if (
          http.download === 'redirect' &&
          this.storage.capabilities.signedUrl.supported &&
          this.storage.capabilities.signedUrl.responseContentDisposition === true
        ) {
          const url = await this.storage.url(ekey, {
            expiresIn: clampExpiry(ov.expiresIn, http.defaultExpiresIn, http.maxExpiresIn),
            responseContentDisposition: dispositionHeader(
              disp,
              name,
              disp === 'inline' ? (await this.storage.head(ekey)).type : undefined,
            ),
          });
          return c.redirect(url, 302);
        }

        const range = parseRange(c.req.header('range'));
        const file = await this.storage.download(ekey, range ? { range } : undefined);
        const headers = new Headers({
          'content-type': file.type,
          'content-length': String(file.size),
          'content-disposition': dispositionHeader(disp, file.name, file.type),
          'x-content-type-options': 'nosniff',
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
        const b = await this.body<{ key: string; expiresIn?: number }>(c);
        const ov = await this.authorize(c, { type: 'download', key: b.key });
        const key = this.userKey(ov.key ?? b.key);
        const expiresIn = clampExpiry(
          ov.expiresIn ?? b.expiresIn,
          http.defaultExpiresIn,
          http.maxExpiresIn,
        );
        if (this.storage.capabilities.signedUrl.responseContentDisposition !== true) {
          throw new StorageError(
            'Unsupported',
            'storage driver cannot bind download response disposition',
          );
        }
        const file = await this.storage.head(key);
        const url = await this.storage.url(key, {
          expiresIn,
          responseContentDisposition: dispositionHeader(undefined, file.name, file.type),
        });
        return c.json({ url, expiresAt: Date.now() + expiresIn * 1000 });
      } catch (e) {
        return this.fail(c, e);
      }
    }
  }

  return StorageController;
}
