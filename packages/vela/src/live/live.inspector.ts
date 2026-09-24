import { Inject, Injectable, Optional } from '../container/decorators';
import { assertWebSocketRoomId } from '../websocket/gateway-routing';
import { LiveEngine } from './live.engine';
import { LIVE_PLATFORM } from './live.tokens';
import type { LiveInspection, LivePlatform } from './live.types';

/** Keep only the rows of the rooms that were asked for. */
function withinRooms(snapshot: LiveInspection, rooms: ReadonlySet<string>): LiveInspection {
  return {
    subscriptions: snapshot.subscriptions.filter((row) => rooms.has(row.room)),
    rooms: snapshot.rooms.filter((row) => rooms.has(row.room)),
  };
}

/**
 * Reads live-query state for an authenticated admin surface such as Studio,
 * one named room at a time: there is no global room list. Each room is read
 * where its subscriptions live: through the platform (`LIVE_PLATFORM`; on
 * Cloudflare, the gateway room's Durable Object, reached through the gateway
 * binding the live driver delivers to), or from this application's engine
 * when the platform has no reader. Only rows for the named rooms are
 * returned; they exclude query arguments, results and identity claims.
 */
@Injectable()
export class LiveInspector {
  constructor(
    @Inject(LiveEngine) private readonly engine: LiveEngine,
    @Optional() @Inject(LIVE_PLATFORM) private readonly platform?: LivePlatform,
  ) {}

  async inspect(rooms: readonly string[]): Promise<LiveInspection> {
    for (const room of rooms) assertWebSocketRoomId(room);
    const wanted = new Set(rooms);
    const platform = this.platform;
    if (!platform?.inspect) return withinRooms(this.engine.inspect(), wanted);
    const inspectRoom = platform.inspect.bind(platform);
    const snapshots = await Promise.all([...wanted].map((room) => inspectRoom(room)));
    const subscriptions: LiveInspection['subscriptions'] = [];
    // One object can also hold sockets that joined another named room.
    const occupancy = new Map<string, LiveInspection['rooms'][number]>();
    for (const snapshot of snapshots) {
      const scoped = withinRooms(snapshot, wanted);
      subscriptions.push(...scoped.subscriptions);
      for (const row of scoped.rooms) {
        const seen = occupancy.get(row.room);
        occupancy.set(
          row.room,
          seen
            ? {
                room: row.room,
                count: seen.count + row.count,
                members: [...seen.members, ...row.members],
              }
            : { room: row.room, count: row.count, members: [...row.members] },
        );
      }
    }
    return { subscriptions, rooms: [...occupancy.values()] };
  }
}
