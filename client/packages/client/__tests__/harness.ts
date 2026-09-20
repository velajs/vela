import type { ClientLiveFrame, ServerLiveFrame } from '@velajs/live-protocol';
import type {
  BroadcastChannelLike,
  MutationStore,
  PersistedMutation,
  WebSocketLike,
} from '../src/types';

/** An in-memory `WebSocketLike` opened/driven by the test (shared across the client-suite). */
export class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  constructor(
    readonly url: string,
    private readonly registry: FakeSocket[],
  ) {
    registry.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  dropFromServer(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  receive(frame: ServerLiveFrame): void {
    this.onmessage?.({ data: JSON.stringify({ event: '$live', data: frame }) });
  }

  liveFrames(): ClientLiveFrame[] {
    return this.sent
      .map((raw) => JSON.parse(raw) as { event: string; data: ClientLiveFrame })
      .filter((envelope) => envelope.event === '$live')
      .map((envelope) => envelope.data);
  }
}

export interface SocketFactory {
  factory: (url: string) => WebSocketLike;
  sockets: FakeSocket[];
  /** Open every socket that isn't open yet (drives connect() to the connected state). */
  openAll(): void;
  last(): FakeSocket;
}

export function makeSocketFactory(): SocketFactory {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    factory: (url: string) => new FakeSocket(url, sockets),
    openAll() {
      for (const socket of sockets) if (socket.readyState === 0) socket.open();
    },
    last() {
      const socket = sockets.at(-1);
      if (!socket) throw new Error('no socket opened yet');
      return socket;
    },
  };
}

/**
 * An in-memory `BroadcastChannel` hub keyed by channel name: `postMessage`
 * fans out synchronously (structured-cloned) to every sibling channel except
 * the sender, exactly like the browser primitive.
 */
export class FakeBroadcastChannel implements BroadcastChannelLike {
  private static readonly hubs = new Map<string, Set<FakeBroadcastChannel>>();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  private closed = false;

  constructor(readonly name: string) {
    let peers = FakeBroadcastChannel.hubs.get(name);
    if (!peers) {
      peers = new Set();
      FakeBroadcastChannel.hubs.set(name, peers);
    }
    peers.add(this);
  }

  postMessage(message: unknown): void {
    if (this.closed) return;
    const peers = FakeBroadcastChannel.hubs.get(this.name);
    if (!peers) return;
    for (const peer of peers) {
      if (peer === this || peer.closed) continue;
      peer.onmessage?.({ data: structuredClone(message) });
    }
  }

  close(): void {
    this.closed = true;
    FakeBroadcastChannel.hubs.get(this.name)?.delete(this);
  }

  static reset(): void {
    FakeBroadcastChannel.hubs.clear();
  }
}

export const broadcastFactory = (name: string): BroadcastChannelLike =>
  new FakeBroadcastChannel(name);

/** A `MutationStore` that fails a chosen operation once, to exercise `onError`. */
export function failingStore(failOn: 'append' | 'load' | 'remove' | 'clear'): MutationStore {
  const records: PersistedMutation[] = [];
  return {
    async append(record) {
      if (failOn === 'append') throw new Error('append quota exceeded');
      records.push({ ...record });
    },
    async load() {
      if (failOn === 'load') throw new Error('load failed');
      return records.map((record) => ({ ...record }));
    },
    async remove(id) {
      if (failOn === 'remove') throw new Error('remove failed');
      const index = records.findIndex((record) => record.id === id);
      if (index !== -1) records.splice(index, 1);
    },
    async clear() {
      if (failOn === 'clear') throw new Error('clear failed');
      records.length = 0;
    },
  };
}

export const tick = async (turns = 4): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
};

export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
