import { defineProvider } from '../container/types';
import { describe, it, expect } from 'vitest';
import {
  VelaFactory,
  Module,
  Global,
  Controller,
  Get,
  UrlGeneratorService,
  SignedUrl,
  URL_SIGNING_SECRET,
  verifySignedUrl,
} from '../index.js';

const SECRET = 'test-signing-secret';

// Declared once at module scope (no MetadataRegistry.clear() here): decorator
// metadata is stable across the cases below, and each test builds its own app
// from the same module tree. Vitest isolates test files, so this does not leak
// into the other suites.

@Global()
@Module({
  providers: [defineProvider(URL_SIGNING_SECRET, {useValue: SECRET})],
  exports: [URL_SIGNING_SECRET],
})
class SecretModule {}

@Controller('/files')
class FilesController {
  @Get('download', { name: 'file.download' })
  @SignedUrl()
  download() {
    return { ok: true };
  }
}

@Module({ imports: [SecretModule], controllers: [FilesController] })
class AppModule {}

@Controller('/pub')
class PublicController {
  @Get('doc', { name: 'pub.doc' })
  doc() {
    return {};
  }
}

@Module({ controllers: [PublicController] })
class NoSecretModule {}

/** Tamper the signature param of a signed relative URL. */
function tamperSignature(signed: string): string {
  const url = new URL(signed, 'http://localhost');
  const sig = url.searchParams.get('signature') ?? '';
  const flipped = (sig.startsWith('A') ? 'B' : 'A') + sig.slice(1);
  url.searchParams.set('signature', flipped);
  return `${url.pathname}?${url.searchParams.toString()}`;
}

describe('signed URLs — UrlGeneratorService.signedUrl + SignedUrlGuard', () => {
  it('a freshly signed URL passes the guard (200)', async () => {
    const app = await VelaFactory.create(AppModule);
    const urls = app.get(UrlGeneratorService);

    const signed = await urls.signedUrl('file.download', {}, { expiresIn: 3600 });
    const res = await app.getHonoApp().request(signed);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('rejects a tampered signature with 403', async () => {
    const app = await VelaFactory.create(AppModule);
    const urls = app.get(UrlGeneratorService);

    const signed = await urls.signedUrl('file.download', {}, { expiresIn: 3600 });
    const res = await app.getHonoApp().request(tamperSignature(signed));

    expect(res.status).toBe(403);
  });

  it('rejects an unsigned request with 403', async () => {
    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/files/download');
    expect(res.status).toBe(403);
  });

  it('rejects malformed signatures with 403 instead of surfacing a 500', async () => {
    const app = await VelaFactory.create(AppModule);
    const res = await app.getHonoApp().request('/files/download?signature=%%%');
    expect(res.status).toBe(403);
  });

  it('rejects invalid expiry at generation', async () => {
    const app = await VelaFactory.create(AppModule);
    const urls = app.get(UrlGeneratorService);

    await expect(urls.signedUrl('file.download', {}, { expiresIn: -10 })).rejects.toThrow(
      /positive/,
    );
  });

  it('honours an explicit secret override, verifiable with the raw util', async () => {
    const app = await VelaFactory.create(AppModule);
    const urls = app.get(UrlGeneratorService);

    const signed = await urls.signedUrl(
      'file.download',
      {},
      { expiresIn: 60, secret: 'other-secret' },
    );

    expect(
      await verifySignedUrl(signed, 'other-secret', {
        method: 'GET',
        purpose: 'vela:http-route',
      }),
    ).toBe(true);
    expect(
      await verifySignedUrl(signed, SECRET, {
        method: 'GET',
        purpose: 'vela:http-route',
      }),
    ).toBe(false);
  });

  it('signedUrl throws a descriptive error when no secret is available', async () => {
    const app = await VelaFactory.create(NoSecretModule);
    const urls = app.get(UrlGeneratorService);

    await expect(urls.signedUrl('pub.doc', {}, { expiresIn: 60 })).rejects.toThrow(
      /No URL signing secret is available/,
    );
  });
});
