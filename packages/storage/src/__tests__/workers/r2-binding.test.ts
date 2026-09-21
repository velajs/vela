// @ts-expect-error - virtual module provided by @cloudflare/vitest-plugin
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createStorage } from '../../index';
import { r2Driver } from '../../drivers/r2';
import type { R2BucketLike } from '../../drivers/r2/r2.types';

// The only faithful test of the native binding path: a real R2 binding under
// workerd/miniflare (TEST_BUCKET from wrangler.toml).
describe('r2Driver under workerd (native binding)', () => {
  const storage = () =>
    createStorage({
      driver: r2Driver({ bucket: (env as { TEST_BUCKET: R2BucketLike }).TEST_BUCKET }),
    });

  it('uploads, downloads, ranges, lists, and deletes', async () => {
    const s = storage();
    await s.upload('greeting.txt', 'hello world', { contentType: 'text/plain' });

    const file = await s.download('greeting.txt');
    expect(await file.text()).toBe('hello world');
    expect(file.type).toBe('text/plain');

    const ranged = await s.download('greeting.txt', { range: { start: 0, end: 4 } });
    expect(await ranged.text()).toBe('hello');

    expect(await s.exists('greeting.txt')).toBe(true);
    const list = await s.list({ prefix: 'greet' });
    expect(list.items.some((i) => i.key === 'greeting.txt')).toBe(true);

    await s.delete('greeting.txt');
    expect(await s.exists('greeting.txt')).toBe(false);
  });

  it('reports native clipped and open-ended range sizes', async () => {
    const s = storage();
    await s.upload('range-size.txt', 'abc');
    for (const range of [
      { start: 0, end: 99 },
      { start: 1, end: 99 },
      { start: 1 },
      { start: 2, end: 2 },
    ]) {
      const file = await s.download('range-size.txt', { range });
      expect(file.size).toBe(3 - range.start);
      expect((await file.arrayBuffer()).byteLength).toBe(file.size);
    }
    await s.delete('range-size.txt');
  });

  it('returns metadata-only native listings with explicit metadata inclusion', async () => {
    const bucket = (env as { TEST_BUCKET: R2BucketLike }).TEST_BUCKET;
    const s = createStorage({ driver: r2Driver({ bucket, includeMetadata: true }) });
    await s.upload('metadata/a.txt', 'abc', {
      contentType: 'text/plain',
      metadata: { owner: 'one' },
    });
    const page = await s.listMetadata({ prefix: 'metadata/' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      key: 'metadata/a.txt',
      type: 'text/plain',
      size: 3,
      metadata: { owner: 'one' },
    });
    expect(page.items[0]).not.toHaveProperty('stream');
    expect(page.hasMore).toBe(false);
    expect(await s.stat('metadata/a.txt')).toMatchObject({
      type: 'text/plain',
      metadata: { owner: 'one' },
    });
    expect(await (await s.download('metadata/a.txt')).text()).toBe('abc');
    await s.delete('metadata/a.txt');
  });

  it('runs a native multipart upload', async () => {
    const s = storage();
    const mp = await s.createMultipartUpload('multi.bin');
    const part = new Uint8Array(6 * 1024 * 1024).fill(65); // 6 MiB of 'A' (>5 MiB min part)
    const p1 = await mp.uploadPart(1, part);
    const p2 = await mp.uploadPart(2, new TextEncoder().encode('tail'));
    await mp.complete([p1, p2]);
    const out = await s.download('multi.bin');
    expect(out.size).toBe(part.byteLength + 4);
    await s.delete('multi.bin');
  });
});
