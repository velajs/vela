import { VelaLiveError } from './errors';
import { MAX_LIVE_FRAME_BYTES } from '@velajs/live-protocol';
import type { BroadcastChannelFactory, BroadcastChannelLike, CrossTabOptions } from './types';

/**
 * Cross-tab coordination over `BroadcastChannel`: elects ONE leader tab that
 * owns the live sockets, while every other tab is a follower that forwards its
 * subscription intent (`want`/`unwant`) and renders the leader's relayed
 * snapshots. The strategic win is one shared connection across N tabs instead
 * of N sockets.
 *
 * When `BroadcastChannel` is unavailable (SSR, Node, React Native), the
 * coordinator is a no-op that reports this tab as the sole leader, so live
 * subscriptions never silently break — the tab just opens its own sockets.
 *
 * Election is clean-room: a starting tab broadcasts `claim`; it self-promotes
 * after `leaderTimeoutMs` unless it sees a leader `heartbeat`; the leader
 * heartbeats every `heartbeatMs`; ties (two tabs claiming at once with no known
 * leader) break by lexicographic `tabId` (lower wins); a follower reclaims when
 * it stops seeing heartbeats for `leaderTimeoutMs`. Heartbeats double as tab
 * liveness so the leader can GC a wanter whose tab vanished.
 */

/** Opaque-to-the-coordinator description of what a follower wants; the leader replays it into a sub. */
export interface WantSpec {
  query: string;
  args: unknown;
  room: string;
  keyField?: string;
}

export interface CrossTabCallbacks {
  onBecomeLeader(): void;
  onResignLeader(): void;
  /** A (new) leader asked every follower to re-declare its wants. */
  onResync(): void;
  onFrame(key: string, value: unknown, cursor: number | undefined, epoch: string | undefined): void;
  onFrameError(key: string, error: { code: string; message: string; fatal: boolean }): void;
  onWant(key: string, spec: WantSpec, fromTab: string): void;
  onUnwant(key: string, fromTab: string): void;
  onTabGone(tabId: string): void;
}

type CrossTabMessage =
  | { scope: string; type: 'claim'; tab: string; ts: number }
  | { scope: string; type: 'heartbeat'; tab: string; ts: number; leader: true }
  | { scope: string; type: 'resign'; tab: string }
  | { scope: string; type: 'want'; tab: string; key: string; spec: WantSpec }
  | { scope: string; type: 'unwant'; tab: string; key: string }
  | {
      scope: string;
      type: 'frame';
      tab: string;
      key: string;
      value: unknown;
      cursor?: number;
      epoch?: string;
    }
  | {
      scope: string;
      type: 'frameError';
      tab: string;
      key: string;
      error: { code: string; message: string; fatal: boolean };
    }
  | { scope: string; type: 'resync'; tab: string };

type CrossTabOutbound = CrossTabMessage extends infer Message
  ? Message extends CrossTabMessage
    ? Omit<Message, 'scope'>
    : never
  : never;

const DEFAULT_CHANNEL = 'velajs-live';
const DEFAULT_HEARTBEAT_MS = 1000;
const DEFAULT_LEADER_TIMEOUT_MS = 3000;

let tabCounter = 0;

export class CrossTabCoordinator {
  /** Globally-unique, ordered id — the leadership tie-break key. */
  readonly tabId: string;

  private readonly channelName: string;
  private readonly heartbeatMs: number;
  private readonly leaderTimeoutMs: number;
  private readonly channel?: BroadcastChannelLike;
  private readonly scope: string;

  private leader = false;
  private started = false;
  private lastLeaderSeen = 0;
  private leaderTab?: string;
  /** Per-tab last-seen timestamp (liveness), for wanter GC. */
  private readonly tabSeen = new Map<string, number>();

  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private leaderCheckTimer?: ReturnType<typeof setInterval>;
  private promoteTimer?: ReturnType<typeof setTimeout>;

  constructor(
    options: CrossTabOptions | undefined,
    private readonly callbacks: CrossTabCallbacks,
  ) {
    if (
      options === undefined ||
      !isBoundedString(options.appId, 1, 128) ||
      !isBoundedString(options.sessionId, 1, 256) ||
      !isBoundedString(options.accountEpoch, 1, 128)
    ) {
      throw new VelaLiveError(
        'CROSS_TAB_SCOPE_REQUIRED',
        'cross-tab coordination requires bounded appId, sessionId, and accountEpoch values',
      );
    }
    this.tabId = `${String((tabCounter += 1)).padStart(12, '0')}-${uuid()}`;
    this.scope = JSON.stringify([options.appId, options.sessionId, options.accountEpoch]);
    const prefix = options.channelName ?? DEFAULT_CHANNEL;
    this.channelName = `${prefix}:${encodeURIComponent(options.appId)}:${encodeURIComponent(
      options.sessionId,
    )}:${encodeURIComponent(options.accountEpoch)}`;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.leaderTimeoutMs = Math.max(
      options.leaderTimeoutMs ?? DEFAULT_LEADER_TIMEOUT_MS,
      this.heartbeatMs + 1,
    );

    let factory: BroadcastChannelFactory | undefined = options.BroadcastChannel;
    if (factory === undefined) {
      const Global = (
        globalThis as { BroadcastChannel?: new (name: string) => BroadcastChannelLike }
      ).BroadcastChannel;
      if (Global !== undefined) factory = (name) => new Global(name);
    }
    if (factory !== undefined) this.channel = factory(this.channelName);
  }

  /** True when this tab owns the sockets. Always true without a BroadcastChannel. */
  isLeader(): boolean {
    return this.leader || this.channel === undefined;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.channel === undefined) {
      // Sole-leader fallback: no coordination surface, own the sockets directly.
      this.leader = true;
      this.callbacks.onBecomeLeader();
      return;
    }
    this.lastLeaderSeen = now();
    this.channel.onmessage = (event) => this.receive(event.data);
    this.broadcast({ type: 'claim', tab: this.tabId, ts: now() });
    this.promoteTimer = setTimeout(() => {
      this.promoteTimer = undefined;
      if (!this.leader) this.promote();
    }, this.leaderTimeoutMs);
    this.leaderCheckTimer = setInterval(() => this.leaderCheck(), this.heartbeatMs);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.leader) this.broadcast({ type: 'resign', tab: this.tabId });
    this.clearTimers();
    if (this.channel !== undefined) {
      this.channel.onmessage = null;
      this.channel.close();
    }
    this.leader = false;
    this.leaderTab = undefined;
  }

  /** Follower → leader: I want the query at `key`. */
  want(key: string, spec: WantSpec): void {
    this.broadcast({ type: 'want', tab: this.tabId, key, spec });
  }

  /** Follower → leader: I no longer want `key`. */
  unwant(key: string): void {
    this.broadcast({ type: 'unwant', tab: this.tabId, key });
  }

  /** Leader → followers: a resolved, optimism-free snapshot + resume watermark for `key`. */
  publishFrame(key: string, value: unknown, cursor?: number, epoch?: string): void {
    if (!this.isLeader()) return;
    this.broadcast({ type: 'frame', tab: this.tabId, key, value, cursor, epoch });
  }

  /** Leader → followers: a subscription error for `key`. */
  publishError(key: string, error: { code: string; message: string; fatal: boolean }): void {
    if (!this.isLeader()) return;
    this.broadcast({ type: 'frameError', tab: this.tabId, key, error });
  }

  private promote(): void {
    if (this.leader) return;
    this.leader = true;
    this.leaderTab = this.tabId;
    this.lastLeaderSeen = now();
    this.startHeartbeat();
    this.callbacks.onBecomeLeader();
    // Rebuild the union: every follower re-sends its wants.
    this.broadcast({ type: 'resync', tab: this.tabId });
  }

  private resign(): void {
    if (!this.leader) return;
    this.leader = false;
    this.leaderTab = undefined;
    this.stopHeartbeat();
    this.broadcast({ type: 'resign', tab: this.tabId });
    this.callbacks.onResignLeader();
  }

  private receive(data: unknown): void {
    const message = parseMessage(data, this.scope);
    if (message === undefined || message.tab === this.tabId) return;

    switch (message.type) {
      case 'claim': {
        this.tabSeen.set(message.tab, now());
        if (this.leader) {
          // Assert leadership so the new tab defers to us.
          this.emitHeartbeat();
        } else if (this.promoteTimer !== undefined && message.tab < this.tabId) {
          // A lower-priority contender: defer, but keep watching for a real leader.
          clearTimeout(this.promoteTimer);
          this.promoteTimer = undefined;
          this.lastLeaderSeen = now();
        }
        return;
      }
      case 'heartbeat': {
        this.tabSeen.set(message.tab, now());
        if (message.leader) {
          this.leaderTab = message.tab;
          this.lastLeaderSeen = now();
          if (this.promoteTimer !== undefined) {
            clearTimeout(this.promoteTimer);
            this.promoteTimer = undefined;
          }
          // Split-brain: the lower tabId wins, the higher resigns.
          if (this.leader && message.tab < this.tabId) this.resign();
        }
        return;
      }
      case 'resign': {
        this.tabSeen.delete(message.tab);
        this.callbacks.onTabGone(message.tab);
        // The leader vanished — reclaim promptly on the next check.
        if (!this.leader && this.leaderTab === message.tab) {
          this.leaderTab = undefined;
          this.lastLeaderSeen = 0;
          this.leaderCheck();
        }
        return;
      }
      case 'want': {
        this.tabSeen.set(message.tab, now());
        if (this.isLeader()) this.callbacks.onWant(message.key, message.spec, message.tab);
        return;
      }
      case 'unwant': {
        this.tabSeen.set(message.tab, now());
        if (this.isLeader()) this.callbacks.onUnwant(message.key, message.tab);
        return;
      }
      case 'frame': {
        this.tabSeen.set(message.tab, now());
        if (!this.leader && message.tab === this.leaderTab) {
          this.callbacks.onFrame(message.key, message.value, message.cursor, message.epoch);
        }
        return;
      }
      case 'frameError': {
        this.tabSeen.set(message.tab, now());
        if (!this.leader && message.tab === this.leaderTab) {
          this.callbacks.onFrameError(message.key, message.error);
        }
        return;
      }
      case 'resync': {
        this.tabSeen.set(message.tab, now());
        // A new leader asked everyone to re-declare intent.
        if (!this.leader && message.tab === this.leaderTab) this.callbacks.onResync();
        return;
      }
    }
  }

  private leaderCheck(): void {
    const current = now();
    if (!this.leader && current - this.lastLeaderSeen > this.leaderTimeoutMs) {
      this.promote();
    }
    if (this.leader) {
      for (const [tab, seen] of this.tabSeen) {
        if (current - seen > this.leaderTimeoutMs) {
          this.tabSeen.delete(tab);
          this.callbacks.onTabGone(tab);
        }
      }
    }
  }

  private startHeartbeat(): void {
    this.emitHeartbeat();
    if (this.heartbeatTimer === undefined) {
      this.heartbeatTimer = setInterval(() => this.emitHeartbeat(), this.heartbeatMs);
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private emitHeartbeat(): void {
    this.lastLeaderSeen = now();
    this.broadcast({ type: 'heartbeat', tab: this.tabId, ts: now(), leader: true });
  }

  private broadcast(message: CrossTabOutbound): void {
    this.channel?.postMessage({ ...message, scope: this.scope });
  }

  private clearTimers(): void {
    if (this.promoteTimer !== undefined) clearTimeout(this.promoteTimer);
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    if (this.leaderCheckTimer !== undefined) clearInterval(this.leaderCheckTimer);
    this.promoteTimer = undefined;
    this.heartbeatTimer = undefined;
    this.leaderCheckTimer = undefined;
  }
}

const parseMessage = (data: unknown, scope: string): CrossTabMessage | undefined => {
  if (!isRecord(data) || data.scope !== scope || !isBoundedString(data.tab, 1, 256)) {
    return undefined;
  }
  if (!isJsonWithin(data, MAX_LIVE_FRAME_BYTES) || typeof data.type !== 'string') {
    return undefined;
  }

  switch (data.type) {
    case 'claim':
      return hasOnly(data, ['scope', 'type', 'tab', 'ts']) && isTimestamp(data.ts)
        ? (data as CrossTabMessage)
        : undefined;
    case 'heartbeat':
      return hasOnly(data, ['scope', 'type', 'tab', 'ts', 'leader']) &&
        isTimestamp(data.ts) &&
        data.leader === true
        ? (data as CrossTabMessage)
        : undefined;
    case 'resign':
    case 'resync':
      return hasOnly(data, ['scope', 'type', 'tab']) ? (data as CrossTabMessage) : undefined;
    case 'unwant':
      return hasOnly(data, ['scope', 'type', 'tab', 'key']) && isBoundedString(data.key, 1, 4096)
        ? (data as CrossTabMessage)
        : undefined;
    case 'want':
      return hasOnly(data, ['scope', 'type', 'tab', 'key', 'spec']) &&
        isBoundedString(data.key, 1, 4096) &&
        isWantSpec(data.spec)
        ? (data as CrossTabMessage)
        : undefined;
    case 'frame':
      return hasOnly(data, ['scope', 'type', 'tab', 'key', 'value', 'cursor', 'epoch']) &&
        isBoundedString(data.key, 1, 4096) &&
        Object.hasOwn(data, 'value') &&
        hasCursorPair(data.cursor, data.epoch)
        ? (data as CrossTabMessage)
        : undefined;
    case 'frameError':
      return hasOnly(data, ['scope', 'type', 'tab', 'key', 'error']) &&
        isBoundedString(data.key, 1, 4096) &&
        isFrameError(data.error)
        ? (data as CrossTabMessage)
        : undefined;
    default:
      return undefined;
  }
};

const isWantSpec = (value: unknown): value is WantSpec =>
  isRecord(value) &&
  hasOnly(value, ['query', 'args', 'room', 'keyField']) &&
  isBoundedString(value.query, 1, 256) &&
  Object.hasOwn(value, 'args') &&
  isJsonWithin(value.args, 32 * 1024) &&
  isBoundedString(value.room, 1, 512) &&
  (value.keyField === undefined || isBoundedString(value.keyField, 1, 128));

const isFrameError = (value: unknown): value is { code: string; message: string; fatal: boolean } =>
  isRecord(value) &&
  hasOnly(value, ['code', 'message', 'fatal']) &&
  isBoundedString(value.code, 1, 128) &&
  isBoundedString(value.message, 0, 2048) &&
  typeof value.fatal === 'boolean';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const hasOnly = (value: Record<string, unknown>, allowed: ReadonlyArray<string>): boolean => {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
};

const isBoundedString = (value: unknown, min: number, max: number): value is string =>
  typeof value === 'string' && value.length >= min && value.length <= max;

const isTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isCursor = (value: unknown): value is number => isTimestamp(value);

const hasCursorPair = (cursor: unknown, epoch: unknown): boolean =>
  (cursor === undefined && epoch === undefined) ||
  (isCursor(cursor) && isBoundedString(epoch, 1, 256));

const isJsonWithin = (value: unknown, maxBytes: number): boolean => {
  try {
    const serialized = JSON.stringify(value);
    return serialized !== undefined && new TextEncoder().encode(serialized).byteLength <= maxBytes;
  } catch {
    return false;
  }
};

const now = (): number => Date.now();

function uuid(): string {
  const generated = (
    globalThis.crypto as { randomUUID?: () => string } | undefined
  )?.randomUUID?.();
  return generated ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
