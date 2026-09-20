import { describe, expect, it } from 'vitest';
import { generateETag, matchesIfMatch, matchesIfNoneMatch } from '../etag';

describe('generateETag', () => {
  it('is a quoted 32-hex strong tag, stable across key order', async () => {
    const a = await generateETag({ b: 1, a: { y: 2, x: [3, { k: 4 }] } });
    const b = await generateETag({ a: { x: [3, { k: 4 }], y: 2 }, b: 1 });
    expect(a).toMatch(/^"[0-9a-f]{32}"$/);
    expect(a).toBe(b);
  });

  it('changes when any value changes', async () => {
    expect(await generateETag({ a: 1 })).not.toBe(await generateETag({ a: 2 }));
  });

  it('hashes Date and BigInt by VALUE (never as {} / never throws)', async () => {
    const t1 = await generateETag({ at: new Date(1000), n: 2n });
    const t2 = await generateETag({ at: new Date(2000), n: 2n });
    const t3 = await generateETag({ at: new Date(1000), n: 3n });
    expect(t1).toMatch(/^"[0-9a-f]{32}"$/);
    expect(t1).not.toBe(t2);
    expect(t1).not.toBe(t3);
  });
});

describe('If-Match / If-None-Match matchers', () => {
  it('If-Match: absent passes, * passes, listed passes, stale fails', async () => {
    const tag = await generateETag({ a: 1 });
    expect(matchesIfMatch(null, tag)).toBe(true);
    expect(matchesIfMatch(undefined, tag)).toBe(true);
    expect(matchesIfMatch('*', tag)).toBe(true);
    expect(matchesIfMatch(`"dead", ${tag}`, tag)).toBe(true);
    expect(matchesIfMatch('"dead"', tag)).toBe(false);
  });

  it('If-None-Match: absent never matches, * always, weak entries compare by tag', async () => {
    const tag = await generateETag({ a: 1 });
    expect(matchesIfNoneMatch(null, tag)).toBe(false);
    expect(matchesIfNoneMatch('*', tag)).toBe(true);
    expect(matchesIfNoneMatch(tag, tag)).toBe(true);
    expect(matchesIfNoneMatch(`W/${tag}`, tag)).toBe(true);
    expect(matchesIfNoneMatch('"dead"', tag)).toBe(false);
  });
});
