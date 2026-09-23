import { Test } from '@velajs/testing';
import { InjectionToken, Module, defineProvider } from '@velajs/vela';
import { describe, expect, it, vi } from 'vitest';
import { StorageModule } from '../index';
import type { StorageDriver, StorageHttpOptions } from '../index';
import { StorageError } from '../storage.error';
import { s3Driver } from '../drivers/s3';
import { memoryDriver } from '../drivers/memory';

function s3Mock() {
  return s3Driver({
    endpoint: 'https://s3.us-east-1.amazonaws.com',
    region: 'us-east-1',
    bucket: 'b',
    forcePathStyle: true,
    credentials: { accessKeyId: 'AK', secretAccessKey: 'sk' },
    fetch: (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.searchParams.get('list-type') === '2') {
        return new Response(
          '<ListBucketResult><Contents><Key>a.txt</Key><Size>3</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>',
        );
      }
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch,
  });
}

async function appWith(http: StorageHttpOptions, useMemory = false) {
  return appWithDriver(http, useMemory ? memoryDriver() : s3Mock());
}

async function appWithDriver(http: StorageHttpOptions, driver: StorageDriver) {
  const moduleRef = await Test.createTestingModule({
    imports: [StorageModule.forRoot({ driver, http })],
  }).compile();
  const app = await moduleRef.createApplication();
  return app.getHonoApp();
}

const post = (path: string, body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const postAs = (body: unknown, actorId: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-actor-id': actorId },
  body: JSON.stringify(body),
});

const GRANT_SECRET = 'test-only-multipart-grant-key-32-bytes-long';

function multipartDriver(completedSize: number, partSize = 5) {
  const base = memoryDriver();
  const create = vi.fn(async () => ({ uploadId: 'upload-1', partSize }));
  const signPart = vi.fn(async () => ({ url: 'https://uploads.example/part' }));
  const abort = vi.fn(async () => {});
  const complete = vi.fn(async (key: string) => {
    await base.upload(key, new Uint8Array(completedSize), {
      contentType: 'application/octet-stream',
    });
    return { key, size: completedSize, contentType: 'application/octet-stream' };
  });
  const driver: StorageDriver = {
    ...base,
    signedMultipart: { create, signPart, abort, complete },
  };
  return { driver, create, signPart, complete, abort, raw: base.raw };
}

async function createMultipart(
  app: Awaited<ReturnType<typeof appWithDriver>>,
  size: number,
  actorId = 'actor-a',
) {
  const response = await app.request(
    '/api/storage/multipart/create',
    postAs({ key: 'video.bin', size }, actorId),
  );
  return { response, body: await response.json() };
}

describe('StorageController', () => {
  it('default-deny: rejects when no authorizer is configured', async () => {
    const app = await appWith({});
    const res = await app.request(
      '/api/storage/sign-upload',
      post('/api/storage/sign-upload', { key: 'a.txt' }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
  });

  it('rejects the removed defaultPolicy allow compatibility path at runtime', async () => {
    await expect(appWith({ defaultPolicy: 'allow' } as never)).rejects.toThrow(
      /defaultPolicy is deny-only/,
    );
  });

  it('redacts internal/provider (5xx) error messages — no raw provider text leaks', async () => {
    const secret = 'bucket=internal-prod host=10.0.0.5 token=sk-live-xyz'; // gitleaks:allow -- synthetic provider-error fixture
    const app = await appWith({
      authorize: () => {
        throw new Error(`provider blew up: ${secret}`);
      },
    });
    const res = await app.request(
      '/api/storage/sign-upload',
      post('x', { key: 'a.txt', contentType: 'text/plain' }),
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe('upstream_error');
    expect(body.error.message).not.toContain(secret);
    expect(body.error.message).not.toContain('10.0.0.5');
  });

  it('echoes developer-authored 4xx messages (no over-redaction)', async () => {
    const app = await appWith({
      authorize: () => {
        throw new StorageError('AccessDenied', 'you lack the media:write scope');
      },
    });
    const res = await app.request('/api/storage/sign-upload', post('x', { key: 'a.txt' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('forbidden');
    expect(body.error.message).toBe('you lack the media:write scope');
  });

  it('redacts raw provider <Message> on a 4xx driver error (S3 AccessDenied 403)', async () => {
    const secret = 'arn:aws:iam::999:role/internal-x denied on bucket=secret-prod host=10.0.0.5';
    const s3 = s3Driver({
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      region: 'us-east-1',
      bucket: 'b',
      forcePathStyle: true,
      credentials: { accessKeyId: 'AK', secretAccessKey: 'sk' },
      fetch: (async () =>
        new Response(`<Error><Code>AccessDenied</Code><Message>${secret}</Message></Error>`, {
          status: 403,
        })) as unknown as typeof fetch,
    });
    const moduleRef = await Test.createTestingModule({
      imports: [StorageModule.forRoot({ driver: s3, http: { authorize: () => true } })],
    }).compile();
    const app = (await moduleRef.createApplication()).getHonoApp();
    const res = await app.request('/api/storage/list?prefix=a');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('forbidden');
    expect(body.error.message).not.toContain('secret-prod');
    expect(body.error.message).not.toContain('10.0.0.5');
  });

  it('mints a presigned PUT when allowed', async () => {
    const app = await appWith({ authorize: () => true });
    const res = await app.request(
      '/api/storage/sign-upload',
      post('x', { key: 'a.txt', contentType: 'text/plain' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toBe('a.txt');
    expect(body.upload.method).toBe('PUT');
    expect(new URL(body.upload.url).searchParams.get('X-Amz-Signature')).toBeTruthy();
  });

  it('applies allow-with-overrides (server rewrites the key)', async () => {
    const app = await appWith({ authorize: (a) => ('key' in a ? { key: `safe/${a.key}` } : true) });
    const res = await app.request('/api/storage/sign-upload', post('x', { key: 'a.txt' }));
    expect((await res.json()).key).toBe('safe/a.txt');
  });

  it('rejects unsafe keys with invalid_key', async () => {
    const app = await appWith({ authorize: () => true });
    const res = await app.request('/api/storage/sign-upload', post('x', { key: '../secret' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_key');
  });

  it('lists and deletes', async () => {
    const app = await appWith({ authorize: () => true });
    const list = await app.request('/api/storage/list?prefix=a');
    expect(list.status).toBe(200);
    expect((await list.json()).items[0].key).toBe('a.txt');

    const del = await app.request('/api/storage/delete', post('x', { keys: ['a.txt'] }));
    expect(del.status).toBe(200);
  });

  // Browsers send text/plain and form-encoded POSTs cross-site without a CORS
  // preflight, so only a JSON media type may reach a state-changing handler.
  it('refuses a text/plain body with 415 before deleting anything', async () => {
    const driver = memoryDriver();
    await driver.upload('a.txt', 'kept');
    const authorize = vi.fn(() => true);
    const app = await appWithDriver({ authorize }, driver);

    const res = await app.request('/api/storage/delete', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ keys: ['a.txt'] }),
    });

    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({
      error: { code: 'invalid_request', message: 'Expected application/json body' },
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(driver.raw.has('a.txt')).toBe(true);
  });

  it.each([
    { name: 'malformed JSON', body: '{"keys":' },
    { name: 'an empty body', body: undefined },
    { name: 'a non-object body', body: '["a.txt"]' },
  ])('rejects $name as invalid_request', async ({ body }) => {
    const app = await appWith({ authorize: () => true }, true);
    const res = await app.request('/api/storage/sign-download', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_request');
  });

  it('redirects downloads to a signed URL', async () => {
    const app = await appWith({ authorize: () => true, download: 'redirect' });
    const res = await app.request('/api/storage/download?key=a.txt');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('X-Amz-Signature=');
  });

  it('forces sign-download URLs to use an attachment disposition', async () => {
    const driver = s3Mock();
    const head = vi.spyOn(driver, 'head');
    const url = vi.spyOn(driver, 'url');
    const app = await appWithDriver({ authorize: () => true }, driver);

    const response = await app.request(
      '/api/storage/sign-download',
      post('x', { key: 'page.html' }),
    );

    expect(response.status).toBe(200);
    expect(head).toHaveBeenCalledWith('page.html', { signal: undefined });
    expect(url).toHaveBeenCalledWith(
      'page.html',
      expect.objectContaining({
        responseContentDisposition: "attachment; filename*=UTF-8''page.html",
      }),
    );
    const body = (await response.json()) as { url: string };
    expect(new URL(body.url).searchParams.get('response-content-disposition')).toBe(
      "attachment; filename*=UTF-8''page.html",
    );
  });

  it('refuses signed downloads when a driver cannot enforce the attachment response', async () => {
    const base = s3Mock();
    const url = vi.fn(base.url.bind(base));
    const driver: StorageDriver = {
      ...base,
      signedUrl: { supported: true, upload: true },
      url,
    };
    const app = await appWithDriver({ authorize: () => true }, driver);

    const response = await app.request(
      '/api/storage/sign-download',
      post('x', { key: 'page.html' }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('capability_unsupported');
    expect(url).not.toHaveBeenCalled();
  });

  it('reports capability_unsupported for presign on a memory driver', async () => {
    const app = await appWith({ authorize: () => true }, true);
    const res = await app.request('/api/storage/sign-upload', post('x', { key: 'a.txt' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('capability_unsupported');
  });

  it('rejects non-positive or non-finite signed URL expiries', async () => {
    const app = await appWith({ authorize: () => true });
    for (const expiresIn of [0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const res = await app.request(
        '/api/storage/sign-upload',
        post('x', { key: 'a.txt', expiresIn }),
      );
      expect(res.status).toBe(400);
    }
  });

  it('requires multipart grant configuration and a trusted actor before allocation', async () => {
    const missingSecret = multipartDriver(10);
    const appWithoutSecret = await appWithDriver(
      { authorize: () => ({ actorId: 'actor-a' }) },
      missingSecret.driver,
    );
    const noSecret = await createMultipart(appWithoutSecret, 10);
    expect(noSecret.response.status).toBe(403);
    expect(missingSecret.create).not.toHaveBeenCalled();

    const missingActor = multipartDriver(10);
    const appWithoutActor = await appWithDriver(
      { authorize: () => true, multipartGrantSecret: GRANT_SECRET },
      missingActor.driver,
    );
    const noActor = await createMultipart(appWithoutActor, 10);
    expect(noActor.response.status).toBe(403);
    expect(missingActor.create).not.toHaveBeenCalled();
  });

  it('reads the multipart grant secret from the forRootAsync factory, failing closed without one', async () => {
    const SECRET = new InjectionToken<string>('test.multipart-grant-secret');

    @Module({ providers: [defineProvider(SECRET, { useValue: GRANT_SECRET })], exports: [SECRET] })
    class SecretsModule {}

    const withSecret = multipartDriver(10);
    const withoutSecret = multipartDriver(10);
    const build = async (
      imported: ReturnType<typeof StorageModule.forRootAsync>,
    ): Promise<Awaited<ReturnType<typeof appWithDriver>>> => {
      const moduleRef = await Test.createTestingModule({ imports: [imported] }).compile();
      return (await moduleRef.createApplication()).getHonoApp();
    };
    const http: StorageHttpOptions = { authorize: () => ({ actorId: 'actor-a' }) };

    const secured = await build(
      StorageModule.forRootAsync({
        imports: [SecretsModule],
        inject: [SECRET],
        useFactory: (secret) => ({ driver: withSecret.driver, multipartGrantSecret: secret }),
        http,
      }),
    );
    const created = await createMultipart(secured, 10);
    expect(created.response.status).toBe(200);
    expect(typeof created.body.grant).toBe('string');

    const unsecured = await build(
      StorageModule.forRootAsync({ useFactory: () => ({ driver: withoutSecret.driver }), http }),
    );
    expect((await createMultipart(unsecured, 10)).response.status).toBe(403);
    expect(withoutSecret.create).not.toHaveBeenCalled();
  });

  it('treats a multipart grant secret shorter than 32 bytes as a server configuration error', async () => {
    const http: StorageHttpOptions = { authorize: () => ({ actorId: 'actor-a' }) };
    // A secret known at module scope fails when the module is set up.
    await expect(
      appWithDriver({ ...http, multipartGrantSecret: 'short' }, multipartDriver(10).driver),
    ).rejects.toThrow(/multipartGrantSecret must contain at least 32 bytes/);

    // A factory secret fails every use until the factory succeeds, as a redacted
    // server error, never a client error that names the setting.
    const fromFactory = multipartDriver(10);
    const moduleRef = await Test.createTestingModule({
      imports: [
        StorageModule.forRootAsync({
          useFactory: () => ({ driver: fromFactory.driver, multipartGrantSecret: 'short' }),
          http,
        }),
      ],
    }).compile();
    const app = (await moduleRef.createApplication()).getHonoApp();
    for (let attempt = 0; attempt < 2; attempt++) {
      const { response, body } = await createMultipart(app, 10);
      expect(response.status).toBe(502);
      expect(body).toEqual({ error: { code: 'upstream_error', message: 'storage backend error' } });
    }
    expect(fromFactory.create).not.toHaveBeenCalled();
  });

  it('binds multipart grants to actor, key, upload, expiry, and bounded part numbers', async () => {
    const mp = multipartDriver(11);
    const app = await appWithDriver(
      {
        authorize: (_action, { req }) => ({ actorId: req.headers.get('x-actor-id') ?? '' }),
        multipartGrantSecret: GRANT_SECRET,
      },
      mp.driver,
    );
    const created = await createMultipart(app, 11);
    expect(created.response.status).toBe(200);
    expect(created.body.partCount).toBe(3);

    const valid = await app.request(
      '/api/storage/multipart/sign-part',
      postAs(
        {
          key: created.body.key,
          uploadId: created.body.uploadId,
          partNumber: 1,
          grant: created.body.grant,
        },
        'actor-a',
      ),
    );
    expect(valid.status).toBe(200);

    const attempts = [
      { actor: 'actor-b', key: created.body.key, partNumber: 1, grant: created.body.grant },
      { actor: 'actor-a', key: 'other.bin', partNumber: 1, grant: created.body.grant },
      { actor: 'actor-a', key: created.body.key, partNumber: 4, grant: created.body.grant },
      {
        actor: 'actor-a',
        key: created.body.key,
        partNumber: 1,
        grant: `${created.body.grant}tampered`,
      },
    ];
    for (const attempt of attempts) {
      const rejected = await app.request(
        '/api/storage/multipart/sign-part',
        postAs(
          {
            key: attempt.key,
            uploadId: created.body.uploadId,
            partNumber: attempt.partNumber,
            grant: attempt.grant,
          },
          attempt.actor,
        ),
      );
      expect([400, 403]).toContain(rejected.status);
    }
    expect(mp.signPart).toHaveBeenCalledTimes(1);
  });

  it('rejects an expired multipart grant before signing a provider URL', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const mp = multipartDriver(5);
      const app = await appWithDriver(
        {
          authorize: () => ({ actorId: 'actor-a' }),
          multipartGrantSecret: GRANT_SECRET,
        },
        mp.driver,
      );
      const createdResponse = await app.request(
        '/api/storage/multipart/create',
        postAs({ key: 'video.bin', size: 5, expiresIn: 1 }, 'actor-a'),
      );
      const created = await createdResponse.json();
      now.mockReturnValue(2_001);

      const response = await app.request(
        '/api/storage/multipart/sign-part',
        postAs(
          {
            key: created.key,
            uploadId: created.uploadId,
            partNumber: 1,
            grant: created.grant,
          },
          'actor-a',
        ),
      );
      expect(response.status).toBe(403);
      expect(mp.signPart).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it('rejects size/part-count overflow before signing and aborts allocated uploads', async () => {
    const overSize = multipartDriver(11);
    const sizeApp = await appWithDriver(
      {
        authorize: () => ({ actorId: 'actor-a', maxSize: 1_000_000 }),
        multipartGrantSecret: GRANT_SECRET,
        maxUploadSize: 10,
      },
      overSize.driver,
    );
    const tooLarge = await createMultipart(sizeApp, 11);
    expect(tooLarge.response.status).toBe(400);
    expect(overSize.create).not.toHaveBeenCalled();

    const tooManyParts = multipartDriver(11, 5);
    const partsApp = await appWithDriver(
      {
        authorize: () => ({ actorId: 'actor-a' }),
        multipartGrantSecret: GRANT_SECRET,
        maxMultipartParts: 2,
      },
      tooManyParts.driver,
    );
    const tooMany = await createMultipart(partsApp, 11);
    expect(tooMany.response.status).toBe(400);
    expect(tooManyParts.abort).toHaveBeenCalledWith(
      expect.stringMatching(/^__vela_internal__\/multipart\//),
      'upload-1',
    );
  });

  it('validates multipart data in quarantine before promoting the final key', async () => {
    const mp = multipartDriver(10);
    const app = await appWithDriver(
      {
        authorize: () => ({ actorId: 'actor-a' }),
        multipartGrantSecret: GRANT_SECRET,
        maxUploadSize: 10,
      },
      mp.driver,
    );
    const created = await createMultipart(app, 10);
    const stagingKey = mp.create.mock.calls[0]![0] as string;
    expect(stagingKey).toMatch(/^__vela_internal__\/multipart\//);
    expect(mp.raw.has('video.bin')).toBe(false);

    const complete = await app.request(
      '/api/storage/multipart/complete',
      postAs(
        {
          key: created.body.key,
          uploadId: created.body.uploadId,
          grant: created.body.grant,
          parts: [
            { partNumber: 1, etag: 'one' },
            { partNumber: 2, etag: 'two' },
          ],
        },
        'actor-a',
      ),
    );
    expect(complete.status).toBe(200);
    expect(mp.complete).toHaveBeenCalledWith(stagingKey, 'upload-1', expect.any(Array));
    expect(mp.raw.has('video.bin')).toBe(true);
    expect(mp.raw.has(stagingKey)).toBe(false);
  });

  it('never exposes a completed multipart object whose actual size violates the grant', async () => {
    const mp = multipartDriver(11);
    const app = await appWithDriver(
      {
        authorize: () => ({ actorId: 'actor-a' }),
        multipartGrantSecret: GRANT_SECRET,
        maxUploadSize: 10,
      },
      mp.driver,
    );
    const created = await createMultipart(app, 10);
    const complete = await app.request(
      '/api/storage/multipart/complete',
      postAs(
        {
          key: created.body.key,
          uploadId: created.body.uploadId,
          grant: created.body.grant,
          parts: [
            { partNumber: 1, etag: 'one' },
            { partNumber: 2, etag: 'two' },
          ],
        },
        'actor-a',
      ),
    );
    expect(complete.status).toBe(400);
    expect(mp.raw.has('video.bin')).toBe(false);
    expect([...mp.raw.keys()]).not.toContainEqual(
      expect.stringMatching(/^__vela_internal__\/multipart\//),
    );
  });

  it('retries quarantine cleanup when post-completion metadata validation fails', async () => {
    const mp = multipartDriver(10);
    const originalHead = mp.driver.head.bind(mp.driver);
    const originalDelete = mp.driver.delete.bind(mp.driver);
    mp.driver.head = vi.fn(async (key, options) => {
      if (key.startsWith('__vela_internal__/multipart/')) {
        throw new Error('provider head failed');
      }
      return originalHead(key, options);
    });
    let deleteAttempts = 0;
    mp.driver.delete = vi.fn(async (key, options) => {
      deleteAttempts += 1;
      if (deleteAttempts < 3) throw new Error('transient cleanup failure');
      return originalDelete(key, options);
    });
    const app = await appWithDriver(
      {
        authorize: () => ({ actorId: 'actor-a' }),
        multipartGrantSecret: GRANT_SECRET,
      },
      mp.driver,
    );
    const created = await createMultipart(app, 10);
    const complete = await app.request(
      '/api/storage/multipart/complete',
      postAs(
        {
          key: created.body.key,
          uploadId: created.body.uploadId,
          grant: created.body.grant,
          parts: [
            { partNumber: 1, etag: 'one' },
            { partNumber: 2, etag: 'two' },
          ],
        },
        'actor-a',
      ),
    );
    expect(complete.status).toBe(502);
    expect(deleteAttempts).toBe(3);
    expect(mp.raw.has('video.bin')).toBe(false);
    expect([...mp.raw.keys()]).toHaveLength(0);
  });

  it('keeps the multipart quarantine namespace inaccessible over HTTP', async () => {
    const driver = memoryDriver();
    await driver.upload('__vela_internal__/multipart/dangling', 'secret');
    await driver.upload('public.txt', 'ok');
    const app = await appWithDriver({ authorize: () => true }, driver);

    const list = await app.request('/api/storage/list');
    expect(list.status).toBe(200);
    expect((await list.json()).items.map((item: { key: string }) => item.key)).toEqual([
      'public.txt',
    ]);
    const head = await app.request(
      '/api/storage/head?key=__vela_internal__%2Fmultipart%2Fdangling',
    );
    expect(head.status).toBe(400);
  });

  it('serves untrusted HTML as attachment with nosniff even when inline is requested', async () => {
    const driver = memoryDriver();
    await driver.upload('page.html', '<script>alert(1)</script>', { contentType: 'text/html' });
    const app = await appWithDriver({ authorize: () => true, download: 'proxy' }, driver);
    const response = await app.request('/api/storage/download?key=page.html&disposition=inline');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
