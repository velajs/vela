import { expect, it, vi } from 'vitest';
import { workflowEventStream } from '../cloudflare/subscription';

const value: WorkflowInstanceEvent = {
  instanceId: 'instance',
  eventId: 1,
  timestamp: 0,
  type: 'workflow_running',
};
function fixture() {
  const dispose = vi.fn();
  const next = vi
    .fn<() => Promise<IteratorResult<WorkflowInstanceEvent, void>>>()
    .mockResolvedValue({ done: false, value });
  const subscribe = vi.fn(async () => ({ next, [Symbol.dispose]: dispose }));
  return { instance: { id: 'instance', subscribe }, dispose, next };
}

it('authorizes before opening and releases the subscription when the reader cancels', async () => {
  const f = fixture();
  const authorize = vi.fn();
  const stream = await workflowEventStream({ instance: f.instance, authorize, cursor: 3 });
  expect(authorize).toHaveBeenCalledWith('instance');
  expect(f.instance.subscribe).toHaveBeenCalledWith({ cursor: 3 });
  expect(f.next).not.toHaveBeenCalled();
  const reader = stream.getReader();
  expect((await reader.read()).value).toEqual(value);
  await reader.cancel();
  expect(f.dispose).toHaveBeenCalledOnce();
});

it('never opens an unauthorized subscription', async () => {
  const f = fixture();
  await expect(
    workflowEventStream({
      instance: f.instance,
      authorize: () => {
        throw new Error('denied');
      },
    }),
  ).rejects.toThrow('denied');
  expect(f.instance.subscribe).not.toHaveBeenCalled();
});

it('disposes and suppresses an event when authorization changes during next()', async () => {
  const f = fixture();
  let allowed = true;
  f.next.mockImplementation(async () => {
    allowed = false;
    return { done: false, value };
  });
  const stream = await workflowEventStream({
    instance: f.instance,
    authorize: () => {
      if (!allowed) throw new Error('revoked');
    },
  });
  await expect(stream.getReader().read()).rejects.toThrow('revoked');
  expect(f.dispose).toHaveBeenCalledOnce();
});

it('abort releases a pending native next() and rejects the consumer immediately', async () => {
  const f = fixture();
  let reading!: () => void;
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  f.next.mockImplementation(() => {
    reading();
    return new Promise(() => {});
  });
  const abort = new AbortController();
  const stream = await workflowEventStream({
    instance: f.instance,
    authorize: () => {},
    signal: abort.signal,
  });
  const pending = stream.getReader().read();
  await started;
  abort.abort(new Error('disconnected'));
  await expect(pending).rejects.toThrow('disconnected');
  expect(f.dispose).toHaveBeenCalledOnce();
});

it.each(['done', 'error'])('cleans up on native %s', async (mode) => {
  const f = fixture();
  if (mode === 'done') f.next.mockResolvedValue({ done: true, value: undefined });
  else f.next.mockRejectedValue(new Error('native error'));
  const reader = (
    await workflowEventStream({ instance: f.instance, authorize: () => {} })
  ).getReader();
  if (mode === 'done') expect((await reader.read()).done).toBe(true);
  else await expect(reader.read()).rejects.toThrow('native error');
  expect(f.dispose).toHaveBeenCalledOnce();
});
