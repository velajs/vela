import { describe, expect, it } from 'vitest';
import { s3Driver } from '../drivers/s3';
import { base64ToBytes } from '../base64';

function mockFetch(handler: (req: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req);
    return handler(req);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function driverWith(handler: (req: Request) => Response | Promise<Response>) {
  const m = mockFetch(handler);
  return {
    driver: s3Driver({
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      region: 'us-east-1',
      bucket: 'my-bucket',
      forcePathStyle: true,
      credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secretkey' },
      fetch: m.fn,
    }),
    calls: m.calls,
  };
}

describe('s3Driver (SigV4 via aws4fetch)', () => {
  it('signs PUT uploads with UNSIGNED-PAYLOAD and user metadata', async () => {
    const { driver, calls } = driverWith(
      () => new Response(null, { status: 200, headers: { etag: '"abc123"' } }),
    );
    const r = await driver.upload('folder/a.txt', 'hello', {
      contentType: 'text/plain',
      metadata: { owner: 'u1' },
    });
    expect(r.etag).toBe('abc123');

    const req = calls[0];
    expect(req.method).toBe('PUT');
    expect(new URL(req.url).pathname).toBe('/my-bucket/folder/a.txt');
    expect(req.headers.get('authorization') ?? '').toMatch(/^AWS4-HMAC-SHA256 /);
    expect(req.headers.get('x-amz-content-sha256')).toBe('UNSIGNED-PAYLOAD');
    expect(req.headers.get('x-amz-meta-owner')).toBe('u1');
    expect(req.headers.get('content-type')).toBe('text/plain');
  });

  it('downloads a body and honors range', async () => {
    const { driver, calls } = driverWith(
      () => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain', 'content-length': '5', etag: '"h"' } }),
    );
    const f = await driver.download('a.txt', { range: { start: 0, end: 4 } });
    expect(await f.text()).toBe('hello');
    expect(f.type).toBe('text/plain');
    expect(calls[0].headers.get('range')).toBe('bytes=0-4');
  });

  it('maps 404 to NotFound on head/exists', async () => {
    const notFound = driverWith(() => new Response('', { status: 404 }));
    expect(await notFound.driver.exists('missing')).toBe(false);
    await expect(notFound.driver.head('missing')).rejects.toMatchObject({ code: 'NotFound' });
  });

  it('parses a ListObjectsV2 response', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <ListBucketResult>
        <Contents><Key>a.txt</Key><Size>5</Size><ETag>&quot;e1&quot;</ETag><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>
        <Contents><Key>b.txt</Key><Size>9</Size><ETag>&quot;e2&quot;</ETag></Contents>
        <CommonPrefixes><Prefix>sub/</Prefix></CommonPrefixes>
        <IsTruncated>true</IsTruncated>
        <NextContinuationToken>TOKEN2</NextContinuationToken>
      </ListBucketResult>`;
    const { driver, calls } = driverWith(() => new Response(xml, { status: 200 }));
    const res = await driver.list({ prefix: 'a', delimiter: '/' });
    expect(res.items.map((i) => i.key)).toEqual(['a.txt', 'b.txt']);
    expect(res.items[0].size).toBe(5);
    expect(res.items[0].etag).toBe('e1');
    expect(res.prefixes).toEqual(['sub/']);
    expect(res.cursor).toBe('TOKEN2');
    expect(new URL(calls[0].url).searchParams.get('list-type')).toBe('2');
  });

  it('runs a multipart upload over signed XML requests', async () => {
    const seen: string[] = [];
    const { driver } = driverWith(async (req) => {
      const u = new URL(req.url);
      if (req.method === 'POST' && u.searchParams.has('uploads')) {
        seen.push('create');
        return new Response('<InitiateMultipartUploadResult><UploadId>UP1</UploadId></InitiateMultipartUploadResult>');
      }
      if (req.method === 'PUT' && u.searchParams.has('partNumber')) {
        seen.push(`part${u.searchParams.get('partNumber')}`);
        return new Response(null, { status: 200, headers: { etag: `"p${u.searchParams.get('partNumber')}"` } });
      }
      if (req.method === 'POST' && u.searchParams.get('uploadId') === 'UP1') {
        seen.push('complete');
        return new Response('<CompleteMultipartUploadResult><ETag>"final"</ETag></CompleteMultipartUploadResult>');
      }
      return new Response('', { status: 400 });
    });

    const mp = await driver.createMultipartUpload!('big');
    expect(mp.uploadId).toBe('UP1');
    const p1 = await mp.uploadPart(1, new TextEncoder().encode('aaa'));
    const p2 = await mp.uploadPart(2, new TextEncoder().encode('bbb'));
    // Part ETags keep their quotes — S3 wants them verbatim in the complete XML.
    expect(p1.etag).toBe('"p1"');
    const done = await mp.complete([p1, p2]);
    expect(done.etag).toBe('final');
    expect(seen).toEqual(['create', 'part1', 'part2', 'complete']);
  });

  it('mints a presigned GET URL (query-signed, no auth header)', async () => {
    const { driver } = driverWith(() => new Response('', { status: 200 }));
    const url = await driver.url('a.txt', { expiresIn: 900 });
    const u = new URL(url);
    expect(u.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(u.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });

  it('mints a presigned PUT and a POST policy (maxSize)', async () => {
    const { driver } = driverWith(() => new Response('', { status: 200 }));
    const put = await driver.signedUploadUrl('a.txt', { expiresIn: 300, contentType: 'image/png' });
    expect(put.method).toBe('PUT');
    if (put.method === 'PUT') expect(new URL(put.url).searchParams.get('X-Amz-Signature')).toBeTruthy();

    const post = await driver.signedUploadUrl('a.txt', { expiresIn: 300, maxSize: 1024 });
    expect(post.method).toBe('POST');
    if (post.method === 'POST') {
      expect(post.fields['x-amz-signature']).toBeTruthy();
      const policy = JSON.parse(new TextDecoder().decode(base64ToBytes(post.fields.policy)));
      const hasRange = policy.conditions.some(
        (c: unknown) => Array.isArray(c) && c[0] === 'content-length-range',
      );
      expect(hasRange).toBe(true);
    }
  });

  it('copies server-side and detects a 200-then-Error body', async () => {
    const ok = driverWith(() => new Response('<CopyObjectResult><ETag>"x"</ETag></CopyObjectResult>', { status: 200 }));
    await ok.driver.copy('a', 'b');
    expect(ok.calls[0].headers.get('x-amz-copy-source')).toBe('/my-bucket/a');

    const err = driverWith(() => new Response('<Error><Code>AccessDenied</Code><Message>no</Message></Error>', { status: 200 }));
    await expect(err.driver.copy('a', 'b')).rejects.toMatchObject({ code: 'AccessDenied' });
  });
});
