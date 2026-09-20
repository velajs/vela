import { describe, expect, it } from 'vitest';
import { memoryDriver } from '../drivers/memory';

const enc = (s: string) => new TextEncoder().encode(s);

describe('memoryDriver', () => {
  it('round-trips upload/download/head/exists/delete', async () => {
    const d = memoryDriver();
    const r = await d.upload('a.txt', 'hello', { contentType: 'text/plain', metadata: { x: '1' } });
    expect(r.size).toBe(5);
    expect(r.key).toBe('a.txt');

    const f = await d.download('a.txt');
    expect(await f.text()).toBe('hello');
    expect(f.type).toBe('text/plain');
    expect(f.metadata).toEqual({ x: '1' });

    expect((await d.head('a.txt')).size).toBe(5);
    expect(await d.exists('a.txt')).toBe(true);

    await d.delete('a.txt');
    expect(await d.exists('a.txt')).toBe(false);
  });

  it('honors byte ranges', async () => {
    const d = memoryDriver({ initial: { k: 'abcdefgh' } });
    expect(await (await d.download('k', { range: { start: 2, end: 4 } })).text()).toBe('cde');
    expect(await (await d.download('k', { range: { start: 6 } })).text()).toBe('gh');
  });

  it('lists with prefix and folds on a delimiter', async () => {
    const d = memoryDriver({ initial: { 'a/1': 'x', 'a/2': 'y', 'a/b/3': 'z', c: 'w' } });
    const flat = await d.list({ prefix: 'a/' });
    expect(flat.items.map((i) => i.key).sort()).toEqual(['a/1', 'a/2', 'a/b/3']);

    const folded = await d.list({ prefix: 'a/', delimiter: '/' });
    expect(folded.items.map((i) => i.key).sort()).toEqual(['a/1', 'a/2']);
    expect(folded.prefixes).toEqual(['a/b/']);
  });

  it('copies, moves, and bulk-deletes', async () => {
    const d = memoryDriver({ initial: { a: '1', b: '2' } });
    await d.copy('a', 'a2');
    expect(await (await d.download('a2')).text()).toBe('1');
    await d.move!('b', 'b2');
    expect(await d.exists('b')).toBe(false);
    expect(await (await d.download('b2')).text()).toBe('2');
    const res = await d.deleteMany!(['a', 'a2']);
    expect(res.deleted).toEqual(['a', 'a2']);
    expect(await d.exists('a')).toBe(false);
  });

  it('round-trips a multipart upload', async () => {
    const d = memoryDriver();
    const mp = await d.createMultipartUpload!('big');
    const p1 = await mp.uploadPart(1, enc('foo'));
    const p2 = await mp.uploadPart(2, enc('bar'));
    const r = await mp.complete([p1, p2]);
    expect(r.size).toBe(6);
    expect(await (await d.download('big')).text()).toBe('foobar');
  });

  it('gives a stable content ETag and throws NotFound on misses', async () => {
    const d = memoryDriver();
    const a = await d.upload('x', 'same');
    const b = await d.upload('y', 'same');
    expect(a.etag).toBe(b.etag);
    await expect(d.download('missing')).rejects.toMatchObject({ code: 'NotFound' });
  });
});
