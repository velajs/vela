import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStorage } from '../storage.facade';
import { memoryDriver } from '../drivers/memory';
import { runWithRetry } from '../internal/retry';
import { StorageError } from '../storage.error';
import { retry } from '../middleware/retry';
import { createStoredFile } from '../internal/stored-file';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

describe('operation controls', () => {
  it('stops waiting on an uncooperative write deadline without retrying it', async () => {
    vi.useFakeTimers();
    const pending = deferred<{ key: string; size: number; contentType: string }>();
    const upload = vi.fn(() => pending.promise);
    const storage = createStorage({ driver: { ...memoryDriver(), upload } });
    const result = storage.upload('a', 'value', { timeout: 10, retries: 3 });
    const rejected = expect(result).rejects.toMatchObject({ code: 'Timeout', retryable: false });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    pending.resolve({ key: 'a', size: 5, contentType: 'text/plain' });
    await Promise.resolve();
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('rejects in-flight cancellation and observes a late provider rejection', async () => {
    const pending = deferred<boolean>();
    const controller = new AbortController();
    const result = runWithRetry(() => pending.promise, { signal: controller.signal, retries: 3 });
    const rejected = expect(result).rejects.toMatchObject({ code: 'Aborted', retryable: false });
    controller.abort();
    await rejected;
    pending.reject(new Error('late provider failure'));
    await Promise.resolve();
  });

  it('cancels a late download body without consuming it', async () => {
    const pending = deferred<ReturnType<typeof createStoredFile>>();
    const controller = new AbortController();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const storage = createStorage({
      driver: { ...memoryDriver(), download: () => pending.promise },
    });
    const result = storage.download('a', { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ code: 'Aborted' });
    controller.abort();
    pending.resolve(createStoredFile({ key: 'a', size: 3 }, { kind: 'stream', stream }));
    await rejected;
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });
  it('does not start I/O for an already-aborted operation', async () => {
    const controller = new AbortController();
    controller.abort();
    const work = vi.fn(async () => true);
    await expect(runWithRetry(work, { signal: controller.signal })).rejects.toMatchObject({
      code: 'Aborted',
    });
    expect(work).not.toHaveBeenCalled();
  });

  it('releases signal listeners and the deadline after success or a synchronous failure', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(
      runWithRetry(async () => true, { signal: controller.signal, timeout: 10 }),
    ).resolves.toBe(true);
    await expect(
      runWithRetry(
        () => {
          throw new StorageError('InvalidRequest', 'bad');
        },
        { signal: controller.signal, timeout: 10 },
      ),
    ).rejects.toMatchObject({ code: 'InvalidRequest' });
    expect(remove).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries settled transient failures and cancels backoff', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const work = vi.fn(async () => {
      throw new StorageError('Network', 'offline');
    });
    const result = runWithRetry(work, {
      signal: controller.signal,
      retries: { max: 2, backoff: () => 100 },
    });
    const rejected = expect(result).rejects.toMatchObject({ code: 'Aborted' });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await rejected;
    expect(work).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    const succeeds = vi
      .fn()
      .mockRejectedValueOnce(new StorageError('Network', 'offline'))
      .mockResolvedValue('ok');
    const retried = runWithRetry(succeeds, { retries: { max: 1, backoff: () => 0 } });
    await vi.runAllTimersAsync();
    await expect(retried).resolves.toBe('ok');
    expect(succeeds).toHaveBeenCalledTimes(2);
  });

  it('leaves a delivered download body under caller ownership', async () => {
    const controller = new AbortController();
    const storage = createStorage({ driver: memoryDriver() });
    await storage.upload('a', 'abc');
    const file = await storage.download('a', { signal: controller.signal });
    controller.abort();
    expect(await file.text()).toBe('abc');
  });

  it('does not compound abandoned writes through retry middleware', async () => {
    vi.useFakeTimers();
    const pending = deferred<{ key: string; size: number; contentType: string }>();
    const upload = vi.fn(() => pending.promise);
    const storage = createStorage({
      driver: retry({ retries: 3 })({ ...memoryDriver(), upload }),
      retries: 3,
    });
    const rejected = expect(storage.upload('a', 'abc', { timeout: 10 })).rejects.toMatchObject({
      code: 'Timeout',
    });
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    pending.resolve({ key: 'a', size: 3, contentType: 'text/plain' });
    await vi.runAllTimersAsync();
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('does not delete the source after a cancelled move copy settles', async () => {
    const pending = deferred<void>();
    const controller = new AbortController();
    const driver = {
      ...memoryDriver(),
      move: undefined,
      copy: () => pending.promise,
      delete: vi.fn(async () => {}),
    };
    const storage = createStorage({ driver });
    const rejected = expect(
      storage.move('a', 'b', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'Aborted' });
    controller.abort();
    await rejected;
    pending.resolve();
    await Promise.resolve();
    expect(driver.delete).not.toHaveBeenCalled();
  });

  it('stops scheduling bulk-delete fallback work after cancellation', async () => {
    const pending = deferred<void>();
    const controller = new AbortController();
    const remove = vi.fn(() => pending.promise);
    const storage = createStorage({
      driver: { ...memoryDriver(), deleteMany: undefined, delete: remove },
    });
    const rejected = expect(
      storage.delete(['a', 'b'], { concurrency: 1, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'Aborted' });
    controller.abort();
    await rejected;
    pending.resolve();
    await Promise.resolve();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('cancels a stalled multipart input and aborts without completing', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const abort = vi.fn(async () => {});
    const complete = vi.fn();
    const driver = {
      ...memoryDriver(),
      createMultipartUpload: async () => ({
        key: 'a',
        uploadId: '1',
        uploadPart: vi.fn(),
        complete,
        abort,
      }),
    };
    const input = new ReadableStream<Uint8Array>({ cancel });
    const rejected = expect(
      createStorage({ driver }).upload('a', input, { timeout: 10 }),
    ).rejects.toMatchObject({ code: 'Timeout' });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    await vi.runAllTimersAsync();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it('aborts multipart handles that arrive after creation was cancelled', async () => {
    const pending = deferred<{
      key: string;
      uploadId: string;
      uploadPart: ReturnType<typeof vi.fn>;
      complete: ReturnType<typeof vi.fn>;
      abort: () => Promise<void>;
    }>();
    const controller = new AbortController();
    const abort = vi.fn(async () => {});
    const storage = createStorage({
      driver: { ...memoryDriver(), createMultipartUpload: () => pending.promise },
    });
    const rejected = expect(
      storage.createMultipartUpload('a', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'Aborted' });
    controller.abort();
    await rejected;
    pending.resolve({ key: 'a', uploadId: '1', uploadPart: vi.fn(), complete: vi.fn(), abort });
    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
  });
  it('cancels multipart input on part failure before asking for another chunk', async () => {
    const cancel = vi.fn();
    const abort = vi.fn(async () => {});
    const uploadPart = vi.fn(async () => {
      throw new StorageError('Provider', 'failed');
    });
    const complete = vi.fn();
    const driver = {
      ...memoryDriver(),
      createMultipartUpload: async () => ({ key: 'a', uploadId: '1', uploadPart, complete, abort }),
    };
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel,
    });
    await expect(
      createStorage({ driver }).upload('a', input, { multipart: { partSize: 1, concurrency: 1 } }),
    ).rejects.toMatchObject({ code: 'Provider' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });
});
