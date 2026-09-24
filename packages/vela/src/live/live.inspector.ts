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
    // One object can hold several named rooms (a gateway without roomParam
    // keeps every room in one), and its sockets can join other named rooms:
    // keep each subscription once by id and each room's members once.
    const subscriptions = new Map<string, LiveInspection['subscriptions'][number]>();
    const occupancy = new Map<string, Set<string>>();
    for (const snapshot of snapshots) {
      const scoped = withinRooms(snapshot, wanted);
      for (const row of scoped.subscriptions) {
        if (!subscriptions.has(row.id)) subscriptions.set(row.id, row);
      }
      for (const row of scoped.rooms) {
        const members = occupancy.get(row.room) ?? new Set<string>();
        for (const member of row.members) members.add(member);
        occupancy.set(row.room, members);
      }
    }
    return {
      subscriptions: [...subscriptions.values()],
      rooms: [...occupancy].map(([room, members]) => ({
        room,
        count: members.size,
        members: [...members],
      })),
    };
  }
}
