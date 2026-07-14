import type { AsyncStorageLike } from '../src/types';

// A minimal WebSocketLike-shaped fake. `@velajs/client`'s WebSocketFactory is
// `(url: string) => WebSocketLike`, so this class is used through that exact
// signature (see `makeSocketFactory`) — no casts. It captures the connect URL
// (that is where the `?token=` auth param lands) and lets a test drive the
// open/drop lifecycle the offline queue reacts to.
export class FakeSocket {
  readyState = 0;
  sent: string[] = [];
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  constructor(
    readonly url: string,
    registry: FakeSocket[],
  ) {
    registry.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket not open');
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  /** Drive the socket to OPEN (connect() reports `connected`). */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Server-side drop (connect() reports `offline`, schedules reconnect). */
  dropFromServer(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

export interface SocketHarness {
  factory: (url: string) => FakeSocket;
  sockets: FakeSocket[];
  last(): FakeSocket;
  openAll(): void;
}

export function makeSocketFactory(): SocketHarness {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    factory: (url: string) => new FakeSocket(url, sockets),
    last() {
      const socket = sockets.at(-1);
      if (socket === undefined) throw new Error('no socket opened yet');
      return socket;
    },
    openAll() {
      for (const socket of sockets) if (socket.readyState === 0) socket.open();
    },
  };
}

export interface FetchHarness {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
  /** Mutate the response the next fetch(es) resolve with. */
  response: { status: number; headers: Record<string, string>; body: unknown };
}

export function makeFetch(): FetchHarness {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const response = { status: 200, headers: {} as Record<string, string>, body: { ok: true } };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: response.headers,
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls, response };
}

/** A Map-backed async key/value store shaped like React Native's AsyncStorage. */
export function makeAsyncStorage(seed?: Record<string, string>): AsyncStorageLike & {
  map: Map<string, string>;
} {
  const map = new Map<string, string>(seed === undefined ? [] : Object.entries(seed));
  return {
    map,
    async getItem(key) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
    async removeItem(key) {
      map.delete(key);
    },
  };
}

/** Flush the microtask queue a few times (never advances real timers). */
export const tick = async (turns = 6): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
};

/** Resolve once `predicate` holds, flushing microtasks between checks. */
export async function until(predicate: () => boolean, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('condition not met in time');
}
