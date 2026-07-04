import { describe, expect, it, vi } from 'vitest';
import { createStorage, StorageError } from '../index';
import { memoryDriver } from '../drivers/memory';
import type { StorageDriver } from '../index';

const noBackoff = { max: 3, backoff: () => 0 };

describe('Storage facade', () => {
  it('gates unsupported capabilities before calling the driver', async () => {
    const noRange: StorageDriver = { ...memoryDriver(), supportsRange: false };
    const s = createStorage({ driver: noRange });
    await s.upload('k', 'value');
    await expect(s.download('k', { range: { start: 0, end: 1 } })).rejects.toMatchObject({
      code: 'Unsupported',
    });

    const noMeta: StorageDriver = { ...memoryDriver(), supportsMetadata: false };
    await expect(createStorage({ driver: noMeta }).upload('k', 'v', { metadata: { a: '1' } })).rejects.toMatchObject(
      { code: 'Unsupported' },
    );

    const s2 = createStorage({ driver: memoryDriver() }); // signedUrl unsupported
    await expect(s2.url('k')).rejects.toMatchObject({ code: 'Unsupported' });
    await expect(s2.signedUploadUrl('k', { expiresIn: 60 })).rejects.toMatchObject({
      code: 'Unsupported',
    });
  });

  it('retries retryable errors and gives up on non-retryable ones', async () => {
    let calls = 0;
    const mem = memoryDriver();
    await mem.upload('k', 'ok');
    const flaky: StorageDriver = {
      ...mem,
      async download(key, opts) {
        calls += 1;
        if (calls < 3) throw new StorageError('Network', 'flaky');
        return mem.download(key, opts);
      },
    };
    const s = createStorage({ driver: flaky, retries: noBackoff });
    expect(await (await s.download('k')).text()).toBe('ok');
    expect(calls).toBe(3);

    let calls2 = 0;
    const hard: StorageDriver = {
      ...memoryDriver(),
      async download() {
        calls2 += 1;
        throw new StorageError('AccessDenied', 'nope');
      },
    };
    await expect(createStorage({ driver: hard, retries: noBackoff }).download('k')).rejects.toMatchObject(
      { code: 'AccessDenied' },
    );
    expect(calls2).toBe(1); // not retried
  });

  it('routes explicit multipart through createMultipartUpload', async () => {
    const driver = memoryDriver();
    const s = createStorage({ driver });
    const r = await s.upload('big', 'abcdef', { multipart: { partSize: 2 } });
    expect(r.size).toBe(6);
    expect(await (await s.download('big')).text()).toBe('abcdef');

    const noMp: StorageDriver = { ...memoryDriver() };
    delete noMp.createMultipartUpload;
    await expect(createStorage({ driver: noMp }).upload('x', 'y', { multipart: true })).rejects.toMatchObject(
      { code: 'Unsupported' },
    );
  });

  it('falls back to copy+delete when the driver has no native move', async () => {
    const driver: StorageDriver = { ...memoryDriver() };
    delete driver.move;
    await driver.upload('a', 'hi');
    const s = createStorage({ driver });
    await s.move('a', 'b');
    expect(await s.exists('a')).toBe(false);
    expect(await (await s.download('b')).text()).toBe('hi');
  });

  it('fans out deleteMany when the driver lacks a native bulk delete', async () => {
    const driver: StorageDriver = { ...memoryDriver() };
    delete driver.deleteMany;
    const s = createStorage({ driver });
    await s.upload('a', '1');
    await s.upload('b', '2');
    const res = await s.delete(['a', 'b', 'missing']);
    expect(res.deleted.sort()).toEqual(['a', 'b', 'missing']); // memory delete is idempotent
    expect(await s.exists('a')).toBe(false);
  });

  it('enforces read-only handles', async () => {
    const s = createStorage({ driver: memoryDriver(), readonly: true });
    await expect(s.upload('k', 'v')).rejects.toMatchObject({ code: 'ReadOnly' });
  });

  it('emits observability hooks', async () => {
    const onOperation = vi.fn();
    const s = createStorage({ driver: memoryDriver(), hooks: { onOperation } });
    await s.upload('k', 'v');
    expect(onOperation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'upload', key: 'k', status: 'success' }),
    );
  });

  it('iterates every page with listAll', async () => {
    const driver = memoryDriver();
    const s = createStorage({ driver });
    for (let i = 0; i < 5; i++) await s.upload(`k${i}`, 'x');
    const keys: string[] = [];
    for await (const f of s.listAll({ limit: 2 })) keys.push(f.key);
    expect(keys.sort()).toEqual(['k0', 'k1', 'k2', 'k3', 'k4']);
  });
});
