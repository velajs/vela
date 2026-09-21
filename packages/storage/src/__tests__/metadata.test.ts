import { describe, expect, it, vi } from 'vitest';
import { createStorage } from '../storage.facade';
import { memoryDriver } from '../drivers/memory';
import { StorageService } from '../storage.service';
import { createStoredFile } from '../internal/stored-file';
import {
  cache,
  compose,
  compression,
  encryption,
  failover,
  retry,
  versioning,
} from '../middleware';

describe('metadata-only storage', () => {
  it('returns scoped snapshots without exposing or touching body readers', async () => {
    const reads = vi.fn(async () => new Response('abc'));
    const file = createStoredFile(
      { key: 'tenant/a', size: 3, metadata: { owner: 'one' } },
      { kind: 'lazy', fetch: reads },
    );
    const head = vi.fn(async () => file);
    const list = vi.fn(async () => ({ items: [file], prefixes: ['tenant/photos/'] }));
    const storage = createStorage({ driver: { ...memoryDriver(), head, list }, prefix: 'tenant' });
    const meta = await storage.stat('a');
    expect(meta).toMatchObject({ key: 'a', name: 'a', size: 3, metadata: { owner: 'one' } });
    expect(meta).not.toHaveProperty('stream');
    meta.metadata!.owner = 'two';
    expect(file.metadata?.owner).toBe('one');
    const page = await storage.listMetadata();
    expect(page).toMatchObject({ items: [{ key: 'a' }], prefixes: ['photos/'], hasMore: false });
    expect(page).not.toHaveProperty('cursor');
    expect(page.items[0]).not.toHaveProperty('text');
    expect(head).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(reads).not.toHaveBeenCalled();
    // Existing 1.x head/list continue to expose their lazy bodies.
    expect(await (await storage.head('a')).text()).toBe('abc');
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('keeps continuation for an empty delimiter-only page', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ items: [], prefixes: ['root/folder/'], cursor: 'next' })
      .mockResolvedValueOnce({ items: [], prefixes: [] });
    const storage = createStorage({ driver: { ...memoryDriver(), list }, prefix: 'root' });
    const first = await storage.listMetadata({ delimiter: '/' });
    expect(first).toEqual({ items: [], prefixes: ['folder/'], hasMore: true, cursor: 'next' });
    if (!first.hasMore) throw new Error('Expected another page');
    const last = await storage.listMetadata({ delimiter: '/', cursor: first.cursor });
    expect(last.hasMore).toBe(false);
    expect(list.mock.calls[1]?.[0]).toMatchObject({ prefix: 'root/', cursor: 'next' });
  });

  it('supports the same additive surface on lazily constructed services', async () => {
    const driver = memoryDriver();
    const build = vi.fn(() => driver);
    const service = new StorageService(build, { name: 'test' });
    expect(build).not.toHaveBeenCalled();
    await service.upload('a', 'abc');
    expect(await service.stat('a')).toMatchObject({ key: 'a', size: 3 });
    expect((await service.listMetadata()).items).toHaveLength(1);
    expect(build).toHaveBeenCalledTimes(1);
    expect(service.storage.raw).toBe(driver.raw);
  });

  it('keeps the native handle through built-in composition and readonly views', async () => {
    const driver = memoryDriver();
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
    const wrapped = compose(
      driver,
      cache(),
      retry(),
      compression(),
      encryption({ key }),
      versioning(),
      failover([memoryDriver()]),
    );
    const storage = createStorage({ driver: wrapped });
    expect(storage.raw).toBe(driver.raw);
    expect(storage.readonly().raw).toBe(driver.raw);
    expect(storage.capabilities.multipart).toBe(false);
  });
});
