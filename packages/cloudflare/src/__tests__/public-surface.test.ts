import { describe, expect, it } from 'vitest';
import * as vela from '@velajs/vela';
import * as websocket from '@velajs/vela/websocket';
import * as live from '@velajs/vela/live';
import * as queue from '@velajs/vela/queue';
import * as cloudflare from '../index';
import * as durableObjects from '../durable-objects';
import * as queues from '../queues';

/**
 * Each framework API has one import path. The Cloudflare adapter exports its own
 * platform pieces and never re-exports core decorators or services, so an app
 * imports gateways from `@velajs/vela/websocket`, not from here.
 */
describe('@velajs/cloudflare public surface', () => {
  it('re-exports nothing from @velajs/vela', () => {
    const core = [vela, websocket, live, queue].map(
      (entry) => entry as unknown as Record<string, unknown>,
    );
    const adapter = [cloudflare, durableObjects, queues].map(
      (entry) => entry as unknown as Record<string, unknown>,
    );
    const reexported = adapter.flatMap((entry) =>
      Object.entries(entry)
        .filter(([name, value]) => core.some((c) => name in c && c[name] === value))
        .map(([name]) => name),
    );
    expect(reexported).toEqual([]);
  });

  it('leaves the gateway decorators to @velajs/vela/websocket', () => {
    for (const name of ['WebSocketGateway', 'SubscribeMessage', 'MessageBody', 'WsException']) {
      expect(name in cloudflare).toBe(false);
      expect(name in websocket).toBe(true);
    }
  });
});
