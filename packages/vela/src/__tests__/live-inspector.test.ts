import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Module, VelaFactory, defineProvider, type VelaApplication } from '../index';
import type { RuntimeAdapter } from '../module-kit';
import { WebSocketGateway, WebSocketModule, WsDispatcher, type WsClient } from '../websocket/index';
import {
  LIVE_PLATFORM,
  LIVE_PROTOCOL,
  LiveInspector,
  LiveModule,
  LiveQuery,
  LiveResolver,
  defineLiveQuery,
  localLive,
  type LiveInspection,
  type LivePlatform,
} from '../live/index';

const PATH = '/rooms/:id/ws';
const countQuery = defineLiveQuery({ name: 'todos.count', args: z.object({}), result: z.number() });

@LiveResolver()
class TodoQueries {
  @LiveQuery(countQuery, { tags: ['todos'] })
  count(): number {
    return 1;
  }
}

@WebSocketGateway({ path: PATH, roomParam: 'id' })
class RoomsGateway {}

class RoomClient implements WsClient {
  readonly rooms: Set<string>;
  data: Record<string, unknown> = {
    principal: { issuer: 'test', subject: 'u1', principalType: 'user' },
    tenantId: 't1',
    expiresAtMs: Date.now() + 60_000,
  };
  readonly raw = null;
  constructor(
    readonly id: string,
    room: string,
  ) {
    this.rooms = new Set([room]);
  }
  send(): void {}
  sendRaw(): void {}
  join(room: string): void {
    this.rooms.add(room);
  }
  leave(room: string): void {
    this.rooms.delete(room);
  }
  commit(): void {}
  close(): void {}
}

function platformAdapter(platform: LivePlatform): RuntimeAdapter {
  return {
    name: 'test-live-platform',
    configureContainer(container) {
      container.register(defineProvider(LIVE_PLATFORM, { useValue: platform }));
      container.markGlobalToken(LIVE_PLATFORM);
    },
  };
}

async function makeApp(adapters: RuntimeAdapter[] = []): Promise<VelaApplication> {
  @Module({
    imports: [WebSocketModule.forRoot(), LiveModule.forRoot()],
    providers: [RoomsGateway, TodoQueries],
  })
  class AppModule {}
  return VelaFactory.create(AppModule, { adapters });
}

async function subscribe(app: VelaApplication, client: RoomClient): Promise<void> {
  const frame = { t: 'sub', sub: 's1', query: 'todos.count', args: {}, v: LIVE_PROTOCOL };
  await app
    .get(WsDispatcher)
    .dispatchMessage(PATH, client, JSON.stringify({ event: '$live', data: frame }));
}

describe('LiveInspector', () => {
  it("reads the named rooms from this application's engine without a platform reader", async () => {
    const app = await makeApp();
    try {
      await subscribe(app, new RoomClient('c1', 'default'));
      await subscribe(app, new RoomClient('c2', 'other'));

      const snapshot = await app.get(LiveInspector).inspect(['default']);
      expect(snapshot.subscriptions).toEqual([
        expect.objectContaining({ query: 'todos.count', room: 'default', clientId: 'c1' }),
      ]);
      expect((await app.get(LiveInspector).inspect([])).subscriptions).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('reads each named room where the platform keeps its subscriptions', async () => {
    const inspected: string[] = [];
    const platform: LivePlatform = {
      liveDriver: () => localLive(),
      async inspect(room): Promise<LiveInspection> {
        inspected.push(room);
        return {
          subscriptions: [
            {
              id: `${room}-s1`,
              query: 'todos.count',
              room,
              clientId: `${room}-client`,
              tags: ['todos'],
              connectedAt: 1,
            },
            // A room the platform object also holds, outside the requested set.
            {
              id: `${room}-s2`,
              query: 'todos.count',
              room: 'elsewhere',
              clientId: `${room}-client`,
              tags: ['todos'],
              connectedAt: 1,
            },
          ],
          rooms: [{ room, count: 1, members: [`${room}-client`] }],
        };
      },
    };
    const app = await makeApp([platformAdapter(platform)]);
    try {
      await subscribe(app, new RoomClient('local', 'default'));
      const snapshot = await app.get(LiveInspector).inspect(['a', 'b']);
      expect(inspected).toEqual(['a', 'b']);
      expect(snapshot).toEqual({
        subscriptions: [
          expect.objectContaining({ id: 'a-s1', room: 'a' }),
          expect.objectContaining({ id: 'b-s1', room: 'b' }),
        ],
        rooms: [
          { room: 'a', count: 1, members: ['a-client'] },
          { room: 'b', count: 1, members: ['b-client'] },
        ],
      });
    } finally {
      await app.close();
    }
  });

  it('reports each row once when several named rooms live in one platform object', async () => {
    const row = (id: string, room: string, clientId: string) => ({
      id,
      query: 'todos.count',
      room,
      clientId,
      tags: ['todos'],
      connectedAt: 1,
    });
    // One object holds every room: each read returns the whole object.
    const platform: LivePlatform = {
      liveDriver: () => localLive(),
      async inspect(): Promise<LiveInspection> {
        return {
          subscriptions: [row('s1', 'a', 'c1'), row('s2', 'b', 'c2'), row('s3', 'b', 'c1')],
          rooms: [
            { room: 'a', count: 1, members: ['c1'] },
            { room: 'b', count: 2, members: ['c1', 'c2'] },
          ],
        };
      },
    };
    const app = await makeApp([platformAdapter(platform)]);
    try {
      const snapshot = await app.get(LiveInspector).inspect(['a', 'b']);
      expect(snapshot.subscriptions.map(({ id }) => id)).toEqual(['s1', 's2', 's3']);
      expect(snapshot.rooms).toEqual([
        { room: 'a', count: 1, members: ['c1'] },
        { room: 'b', count: 2, members: ['c1', 'c2'] },
      ]);
    } finally {
      await app.close();
    }
  });

  it('rejects a room id no gateway room can carry', async () => {
    const app = await makeApp();
    try {
      await expect(app.get(LiveInspector).inspect([''])).rejects.toThrow(/room/);
    } finally {
      await app.close();
    }
  });
});
