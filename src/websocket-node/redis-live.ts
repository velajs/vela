import type { CommitStamp, InvalidationCommand, LiveDriver, LiveInvalidationSink } from '../live/index';
import type { RedisPubSubClient } from './redis-sync';

export interface RedisLiveOptions {
  /** Connection used to publish invalidations. */
  pub: RedisPubSubClient;
  /** Separate connection kept in subscriber mode. */
  sub: RedisPubSubClient;
  /** Channel prefix. Default `vela:live`. */
  prefix?: string;
}

const swallow = (op: unknown): void => {
  void Promise.resolve(op).catch(() => {});
};

/**
 * Cross-instance live-invalidation driver for node/bun via Redis pub/sub —
 * the live sibling of the WebSocket `redis()` sync driver, carrying TAGS
 * instead of frames. Local-first: `dispatch` applies to this instance's
 * engine immediately (its log stamps the returned commit cursor), then fans
 * the command out so every peer re-runs ITS local subscriptions.
 *
 * Guarantees (same honesty as `redis()`): at-most-once, no cross-publisher
 * ordering, no replay. Each instance keeps its own per-process epoch, so a
 * client reconnecting onto a different instance always receives a full
 * snapshot — exactly the protocol's multi-instance-node rule. Real cursor
 * resume needs a shared ordered log (the Cloudflare DO transport).
 */
export function redisLive(options: RedisLiveOptions): LiveDriver {
  const prefix = options.prefix ?? 'vela:live';
  const channel = `${prefix}:invalidate`;
  const origin = crypto.randomUUID();
  let sink: LiveInvalidationSink | undefined;
  let bound = false;

  const onMessage = (ch: string, message: string): void => {
    if (ch !== channel) return;
    let cmd: InvalidationCommand;
    try {
      cmd = JSON.parse(message) as InvalidationCommand;
    } catch {
      return;
    }
    if (cmd.origin === origin) return; // our own publish — already applied locally
    if (sink) swallow(sink.applyInvalidation(cmd));
  };

  return {
    kind: 'redis',
    bind(boundSink) {
      sink = boundSink;
      if (bound) return; // idempotent — never stack duplicate 'message' listeners
      bound = true;
      swallow(options.sub.subscribe(channel));
      options.sub.on('message', onMessage);
    },
    async dispatch(cmd): Promise<CommitStamp | undefined> {
      swallow(options.pub.publish(channel, JSON.stringify({ ...cmd, origin })));
      return sink?.applyInvalidation(cmd);
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
