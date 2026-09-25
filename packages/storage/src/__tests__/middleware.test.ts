import { describe, expect, it } from 'vitest';
import { createStorage, StorageError } from '../index';
import type { StorageDriver } from '../index';
import { memoryDriver } from '../drivers/memory';
import {
  cache,
  compose,
  compression,
  encryption,
  failover,
  retry,
  unwrapVersioning,
  versioning,
} from '../middleware';

describe('middleware', () => {
  it('cache serves head/exists from the store and invalidates on write', async () => {
    const mem = memoryDriver();
    await mem.upload('k', 'v');
    let headCalls = 0;
    const counting: StorageDriver = {
      ...mem,
      async head(key, o) {
        headCalls += 1;
        return mem.head(key, o);
      },
    };
    const d = compose(counting, cache({ ttlMs: 10_000 }));
    await d.head('k');
    await d.head('k');
    expect(headCalls).toBe(1); // second read is cached
    await d.upload('k', 'v2'); // invalidates
    await d.head('k');
    expect(headCalls).toBe(2);
  });

  it('encryption round-trips and blocks direct URLs', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const mem = memoryDriver();
    const d = compose(mem, encryption({ key }));
    await d.upload('k', 'top-secret', { contentType: 'text/plain' });

    const stored = mem.raw.get('k')!.bytes;
    expect(new TextDecoder().decode(stored)).not.toContain('top-secret'); // ciphertext at rest
    expect(d.supportsRange).toBe(false);
    expect(typeof d.createMultipartUpload).toBe('undefined'); // suppressed

    const s = createStorage({ driver: d });
    expect(await (await s.download('k')).text()).toBe('top-secret');
    expect((await s.download('k')).type).toBe('text/plain'); // content-type restored
    await expect(s.url('k')).rejects.toMatchObject({ code: 'Unsupported' });
  });

  it('compression round-trips and shrinks compressible data', async () => {
    const mem = memoryDriver();
    const d = compose(mem, compression());
    const text = 'hello world '.repeat(500);
    await d.upload('k', text, { contentType: 'text/plain' });

    const stored = mem.raw.get('k')!.bytes;
    expect(stored.byteLength).toBeLessThan(text.length); // actually compressed
    expect(mem.raw.get('k')!.metadata?.['vela-zip']).toBe('gzip');

    const f = await d.download('k');
    expect(await f.text()).toBe(text);
    expect(f.type).toBe('text/plain');
  });

  it('versioning snapshots overwrites and restores', async () => {
    const mem = memoryDriver();
    const d = compose(mem, versioning());
    await d.upload('doc', 'v1');
    await d.upload('doc', 'v2');

    const versioned = unwrapVersioning(d)!;
    expect(versioned).toBeTruthy();
    const versions = await versioned.listVersions('doc');
    expect(versions.length).toBe(1);
    expect(await (await d.download('doc')).text()).toBe('v2');

    await versioned.restore('doc', versions[0].versionId);
    expect(await (await d.download('doc')).text()).toBe('v1');

    const list = await d.list({});
    expect(list.items.every((i) => !i.key.startsWith('.vela-versions/'))).toBe(true);
  });

  it('failover reads from a fallback when the primary fails', async () => {
    const primary = memoryDriver();
    const fallback = memoryDriver();
    await fallback.upload('k', 'from-fallback');
    const failingPrimary: StorageDriver = {
      ...primary,
      async download() {
        throw new StorageError('Network', 'primary down');
      },
    };
    const d = compose(failingPrimary, failover([fallback]));
    expect(await (await d.download('k')).text()).toBe('from-fallback');
  });

  it('retry recovers from transient failures', async () => {
    let n = 0;
    const mem = memoryDriver();
    await mem.upload('k', 'ok');
    const flaky: StorageDriver = {
      ...mem,
      async download(key, o) {
        if (n++ < 2) throw new StorageError('Network', 'flaky');
        return mem.download(key, o);
      },
    };
    const d = compose(flaky, retry({ retries: { max: 3, backoff: () => 0 } }));
    expect(await (await d.download('k')).text()).toBe('ok');
    expect(n).toBe(3);
  });
});

it('rejects untagged compressed objects and invalid ciphertext', async () => {
  const mem = memoryDriver();
  await mem.upload('plain', 'unencrypted data longer than a frame header');
  const zipped = compose(mem, compression());
  await expect(zipped.download('plain')).rejects.toThrow('vela-zip');
  await expect(zipped.head('plain')).rejects.toThrow('vela-zip');
  const key = crypto.getRandomValues(new Uint8Array(32));
  const encrypted = compose(mem, encryption({ key }));
  await expect(encrypted.download('plain')).rejects.toThrow('decryption failed');
});
