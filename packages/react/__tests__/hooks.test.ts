import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { createClientQuery, LiveClient } from '@velajs/client';
import type { ConnectionStatus, MutateOptions } from '@velajs/client';
import {
  LiveProvider,
  useClientQuery,
  useConnectionStatus,
  useLiveMutation,
  useLiveQuery,
  usePresence,
} from '../src/index';

interface Entry {
  value: unknown;
  listeners: Set<(value: unknown) => void>;
}

function makeFakeClient() {
  const entries = new Map<string, Entry>();
  const beats: Array<{ room: string; meta?: unknown }> = [];
  const statusListeners = new Set<(status: ConnectionStatus) => void>();
  let status: ConnectionStatus = 'idle';
  let mutateImpl: (
    path: string,
    body?: unknown,
    options?: MutateOptions,
  ) => Promise<unknown> = async () => ({});

  const keyOf = (query: string, args: unknown, room?: string): string =>
    `${room ?? 'default'}|${query}|${JSON.stringify(args ?? null)}`;

  const client = {
    subscribe(
      query: string,
      args: unknown,
      cb: (value: unknown) => void,
      opts?: { room?: string },
    ) {
      const key = keyOf(query, args, opts?.room);
      let entry = entries.get(key);
      if (!entry) {
        entry = { value: undefined, listeners: new Set() };
        entries.set(key, entry);
      }
      entry.listeners.add(cb);
      if (entry.value !== undefined) cb(entry.value);
      return () => entry.listeners.delete(cb);
    },
    peek(query: string, args: unknown, room?: string) {
      return entries.get(keyOf(query, args, room))?.value;
    },
    mutate(path: string, body?: unknown, options?: MutateOptions) {
      return mutateImpl(path, body, options);
    },
    presenceBeat(room: string, meta?: unknown) {
      beats.push({ room, meta });
    },
    onConnectionStatus(listener: (status: ConnectionStatus) => void) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    connectionStatus: () => status,
  } as unknown as LiveClient;

  return {
    client,
    beats,
    push(query: string, args: unknown, value: unknown, room?: string) {
      const entry = entries.get(keyOf(query, args, room));
      if (!entry) throw new Error(`no subscription for ${keyOf(query, args, room)}`);
      entry.value = value;
      for (const listener of entry.listeners) listener(value);
    },
    setStatus(next: ConnectionStatus) {
      status = next;
      for (const listener of statusListeners) listener(next);
    },
    setMutate(impl: typeof mutateImpl) {
      mutateImpl = impl;
    },
    subscriberCount: (query: string, args: unknown, room?: string) =>
      entries.get(keyOf(query, args, room))?.listeners.size ?? 0,
  };
}

const wrapperFor = (client: LiveClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(LiveProvider, { client }, children);
  };

describe('useLiveQuery', () => {
  it('renders undefined, then the pushed value; unsubscribes on unmount', async () => {
    const fake = makeFakeClient();
    const { result, unmount } = renderHook(() => useLiveQuery('todos.list', { listId: 'l1' }), {
      wrapper: wrapperFor(fake.client),
    });
    expect(result.current).toBeUndefined();

    act(() => fake.push('todos.list', { listId: 'l1' }, [{ id: 'a' }]));
    expect(result.current).toEqual([{ id: 'a' }]);

    unmount();
    expect(fake.subscriberCount('todos.list', { listId: 'l1' })).toBe(0);
  });

  it('skip renders without subscribing', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() => useLiveQuery('todos.list', {}, { skip: true }), {
      wrapper: wrapperFor(fake.client),
    });
    expect(result.current).toBeUndefined();
    expect(fake.subscriberCount('todos.list', {})).toBe(0);
  });
});

describe('useLiveMutation', () => {
  it('tracks pending/data and surfaces errors', async () => {
    const fake = makeFakeClient();
    let release!: (value: unknown) => void;
    fake.setMutate(() => new Promise((resolve) => (release = resolve)));

    const { result } = renderHook(() => useLiveMutation('/todos'), {
      wrapper: wrapperFor(fake.client),
    });
    let promise!: Promise<unknown>;
    act(() => {
      promise = result.current.mutate({ text: 'x' });
    });
    expect(result.current.pending).toBe(true);

    await act(async () => {
      release({ ok: true });
      await promise;
    });
    expect(result.current.pending).toBe(false);
    expect(result.current.data).toEqual({ ok: true });

    fake.setMutate(async () => {
      throw new Error('boom');
    });
    await act(async () => {
      await expect(result.current.mutate()).rejects.toThrow('boom');
    });
    expect((result.current.error as Error).message).toBe('boom');
  });
});

describe('useConnectionStatus', () => {
  it('tracks the client status', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() => useConnectionStatus(), {
      wrapper: wrapperFor(fake.client),
    });
    expect(result.current).toBe('idle');
    act(() => fake.setStatus('connected'));
    expect(result.current).toBe('connected');
  });
});

describe('useClientQuery', () => {
  it('returns [value, setter] with no undefined flash, re-renders on set, shared across consumers', () => {
    const client = new LiveClient({ url: 'http://api.test' });
    const filter = createClientQuery('ui.filter', 'all');

    const first = renderHook(() => useClientQuery(filter), { wrapper: wrapperFor(client) });
    expect(first.result.current[0]).toBe('all'); // default, never undefined

    act(() => first.result.current[1]('active'));
    expect(first.result.current[0]).toBe('active');

    // A second consumer of the same ref shares the value and re-renders on writes.
    const second = renderHook(() => useClientQuery(filter), { wrapper: wrapperFor(client) });
    expect(second.result.current[0]).toBe('active');

    act(() => second.result.current[1]('done'));
    expect(first.result.current[0]).toBe('done');
    expect(second.result.current[0]).toBe('done');
  });
});

describe('usePresence', () => {
  it('heartbeats with the latest meta, updates the roster, beats on visibility regain', async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeClient();
      const { result, rerender, unmount } = renderHook(
        ({ name }: { name: string }) =>
          usePresence('lobby', { meta: { name }, heartbeatIntervalMs: 1000 }),
        { wrapper: wrapperFor(fake.client), initialProps: { name: 'kauan' } },
      );

      act(() => vi.advanceTimersByTime(0)); // the immediate first beat rides a timeout(0)-ish tick
      expect(fake.beats.at(-1)).toEqual({ room: 'lobby', meta: { name: 'kauan' } });

      // Roster push re-renders.
      act(() =>
        fake.push('$presence.roster', { room: 'lobby' }, [{ id: 'c1', lastSeen: 1 }], 'lobby'),
      );
      expect(result.current).toEqual([{ id: 'c1', lastSeen: 1 }]);

      // Later beats carry the LATEST render's meta.
      rerender({ name: 'renamed' });
      act(() => vi.advanceTimersByTime(1000));
      expect(fake.beats.at(-1)).toEqual({ room: 'lobby', meta: { name: 'renamed' } });

      // Visibility regain triggers an immediate beat.
      const before = fake.beats.length;
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(fake.beats.length).toBe(before + 1);

      const total = fake.beats.length;
      unmount();
      act(() => vi.advanceTimersByTime(5000));
      expect(fake.beats.length).toBe(total); // stopped
      expect(fake.subscriberCount('$presence.roster', { room: 'lobby' }, 'lobby')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
