import { expect, it, vi } from 'vitest';
import { limitStream, readBytes, waitForResponse } from '../src/bounds';
import { bytesStream, deferred, encoded } from './support';

it('disposes a supplied response body if abort happened before readBytes entered', async () => {
  const controller = new AbortController();
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>({ cancel });
  const reason = new Error('already aborted');
  controller.abort(reason);
  // A never-settling native cancel must not extend the request lifetime.
  await expect(readBytes(body, 20, controller.signal)).rejects.toBe(reason);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('closes the race between native response settlement and acquiring the body reader', async () => {
  const controller = new AbortController();
  const body = bytesStream(encoded('late boundary'), false);
  const response = await waitForResponse(
    Promise.resolve(new Response(body.stream)),
    controller.signal,
  );
  controller.abort(new Error('gone'));
  await expect(readBytes(response.body, 20, controller.signal)).rejects.toThrow('gone');
  expect(body.cancel).toHaveBeenCalled();
});

it('releases an active reader on abort even when native cancel never settles', async () => {
  const controller = new AbortController();
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>({ cancel });
  const done = vi.fn();
  const reader = limitStream(body, 10, controller.signal, done).getReader();
  const reading = reader.read();
  controller.abort(new Error('gone'));
  await expect(reading).rejects.toThrow('gone');
  expect(body.locked).toBe(false);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(done).toHaveBeenCalledTimes(1);
});

it('discards late output without waiting for an uncooperative cancellation', async () => {
  const controller = new AbortController();
  const pending = deferred<Response>();
  const response = waitForResponse(pending.promise, controller.signal);
  controller.abort(new Error('gone'));
  await expect(response).rejects.toThrow('gone');
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  pending.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
});
