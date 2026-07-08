import { describe, expect, it } from 'vitest';
import { redisLive } from '../websocket-node/redis-live';
import type { RedisPubSubClient } from '../websocket-node/redis-sync';
import type { CommitStamp, InvalidationCommand, LiveInvalidationSink } from '../live/index';

/** In-memory pub/sub bus wiring N fake instances together. */
function makeBus() {
  const listeners = new Set<(channel: string, message: string) => void>();
  const clientPair = (): RedisPubSubClient => ({
    publish(channel, message) {
      for (const listener of listeners) listener(channel, message);
    },
    subscribe() {},
    on(_event, listener) {
      listeners.add(listener);
    },
    off(_event, listener) {
      listeners.delete(listener);
    },
  });
  return { clientPair };
}

function makeSink(): LiveInvalidationSink & { applied: InvalidationCommand[] } {
  const applied: InvalidationCommand[] = [];
  let cursor = 0;
  return {
    applied,
    applyInvalidation(cmd): CommitStamp {
      applied.push(cmd);
      cursor += 1;
      return { cursor, epoch: 'local-epoch' };
    },
  };
}

describe('redisLive', () => {
  it('applies locally (returning the local stamp), fans out to peers, drops its own echo', async () => {
    const bus = makeBus();
    const a = redisLive({ pub: bus.clientPair(), sub: bus.clientPair() });
    const b = redisLive({ pub: bus.clientPair(), sub: bus.clientPair() });
    const sinkA = makeSink();
    const sinkB = makeSink();
    a.bind(sinkA);
    b.bind(sinkB);

    const stamp = await a.dispatch({ tags: ['crud:todos'] });
    await Promise.resolve(); // swallow()-deferred peer delivery

    expect(stamp).toEqual({ cursor: 1, epoch: 'local-epoch' }); // the dispatcher's OWN log stamps the response
    expect(sinkA.applied).toHaveLength(1); // applied locally exactly once (echo dropped)
    expect(sinkB.applied).toHaveLength(1); // peer re-runs its local subscriptions
    expect(sinkB.applied[0].tags).toEqual(['crud:todos']);
  });

  it('stops cleanly and ignores foreign channels/garbage', async () => {
    const bus = makeBus();
    const sub = bus.clientPair();
    const driver = redisLive({ pub: bus.clientPair(), sub });
    const sink = makeSink();
    driver.bind(sink);

    sub.publish?.('other:channel', JSON.stringify({ tags: ['x'] }));
    bus.clientPair().publish('vela:live:invalidate', 'not json');
    await Promise.resolve();
    expect(sink.applied).toHaveLength(0);

    driver.stop?.();
    bus.clientPair().publish('vela:live:invalidate', JSON.stringify({ tags: ['x'], origin: 'peer' }));
    await Promise.resolve();
    expect(sink.applied).toHaveLength(0); // unsubscribed
  });
});
