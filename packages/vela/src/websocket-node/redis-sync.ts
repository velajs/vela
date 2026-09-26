import {
  assertBroadcastCommandFits,
  broadcastCommandFits,
  DEFAULT_WS_MAX_FRAME_BYTES,
  resolveMaxFrameBytes,
  webSocketSyncEnvelopeFits,
} from '../websocket/index';
import type { BroadcastCommand, RoomRegistry, SyncDriver } from '../websocket/index';

/**
 * Minimal Redis pub/sub surface (satisfied by `ioredis` / `node-redis`). Pub and
 * sub MUST be separate connections — a subscribed Redis connection cannot publish.
 * `off`/`removeListener`/`unsubscribe` are optional and used only by `stop()`.
 */
export interface RedisPubSubClient {
  publish(channel: string, message: string): unknown;
  subscribe(channel: string): unknown;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  off?(event: 'message', listener: (channel: string, message: string) => void): unknown;
  removeListener?(event: 'message', listener: (channel: string, message: string) => void): unknown;
  unsubscribe?(channel: string): unknown;
}

export interface RedisSyncOptions {
  /** Connection used to publish broadcast commands. */
  pub: RedisPubSubClient;
  /** Separate connection used to subscribe (kept in subscriber mode). */
  sub: RedisPubSubClient;
  /** Channel prefix. Default `vela:ws`. */
  prefix?: string;
}

const swallow = (op: unknown): void => {
  // Redis client calls return promises that reject on transport failure; a
  // fan-out miss must never become an unhandled rejection that crashes the app.
  void Promise.resolve(op).catch(() => {});
};

/**
 * Cross-instance sync driver for node/bun via Redis pub/sub. Local-first: every
 * `dispatch` delivers to this instance's sockets immediately, then fans the
 * command out to peers on a single broadcast channel; each peer's registry
 * filters delivery to its own local room members. The publishing instance drops
 * its own echo via an `origin` stamp.
 *
 * Guarantees: at-most-once, no ordering across publishers, no replay — a fan-out
 * bus, not a log. Construct it in `WebSocketModule.forRoot({ sync: () => redis({ pub, sub }) })`.
 */
export function redis(options: RedisSyncOptions): SyncDriver {
  const prefix = options.prefix ?? 'vela:ws';
  const channel = `${prefix}:broadcast`;
  const origin = crypto.randomUUID();
  let registry: RoomRegistry | undefined;
  let bound = false;
  let maxFrameBytes = DEFAULT_WS_MAX_FRAME_BYTES;

  const onMessage = (ch: string, message: string): void => {
    if (ch !== channel) return;
    if (!webSocketSyncEnvelopeFits(message, maxFrameBytes)) return;
    let cmd: BroadcastCommand & { origin?: string };
    try {
      cmd = JSON.parse(message);
    } catch {
      return;
    }
    if (!broadcastCommandFits(cmd, maxFrameBytes)) return;
    if (cmd.origin === origin) return; // our own publish — already delivered locally
    swallow(registry?.deliverLocal(cmd));
  };

  return {
    kind: 'redis',
    bind(reg) {
      registry = reg;
      if (bound) return; // idempotent — never stack duplicate 'message' listeners on re-bind
      bound = true;
      swallow(options.sub.subscribe(channel));
      options.sub.on('message', onMessage);
    },
    dispatch(cmd) {
      assertBroadcastCommandFits(cmd, maxFrameBytes);
      const serialized = JSON.stringify({ ...cmd, origin });
      if (!webSocketSyncEnvelopeFits(serialized, maxFrameBytes)) {
        throw new RangeError('WebSocket synchronization envelope exceeds its configured limit');
      }
      swallow(registry?.deliverLocal(cmd));
      swallow(options.pub.publish(channel, serialized));
    },
    setMaxFrameBytes(value) {
      maxFrameBytes = resolveMaxFrameBytes({ maxFrameBytes: value });
    },
    stop() {
      if (!bound) return;
      bound = false;
      options.sub.off?.('message', onMessage);
      options.sub.removeListener?.('message', onMessage);
      swallow(options.sub.unsubscribe?.(channel));
    },
  };
}
