import { MAX_PRESENCE_METADATA_BYTES } from '@velajs/live-protocol';
import { Inject, Injectable, assertWebSocketRoomId } from '../index';
import { LiveQuery, LiveResolver } from './live.decorators';
import type { LiveQueryContext } from './live.types';

const encoder = new TextEncoder();

/** The invalidation tag for one room's roster. `$`-prefixed: never collides with app tags. */
export const presenceTag = (room: string): string => {
  assertWebSocketRoomId(room);
  return `$presence:${room}`;
};

/** The built-in roster query name (`useLiveQuery`-able like any app query). */
export const PRESENCE_ROSTER_QUERY = '$presence.roster';

/** One present connection as returned by the roster query. Keyed by `id` so list deltas apply. */
export interface PresenceMember {
  /** The connection id that heartbeats this membership. */
  id: string;
  meta?: unknown;
  lastSeen: number;
}

interface RoomState {
  members: Map<string, { meta?: unknown; lastSeen: number }>;
}

/**
 * The presence preset's server half. Heartbeats arrive as `{ t: 'presence' }`
 * frames on the live socket (routed here by the engine); the roster is a
 * built-in live query invalidated per room. Departure is immediate: the WS
 * close hook reaps the member without waiting out the TTL. Staleness (an
 * ungraceful drop the transport never noticed) is filtered AT READ TIME —
 * no timers, per the edge rules (`setInterval` is forbidden).
 *
 * Scope note: the roster lives in this log scope (one process on node, one
 * room-DO on Cloudflare — where it is exactly the room's roster).
 */
export class PresenceService {
  private readonly rooms = new Map<string, RoomState>();
  private readonly roomsByClient = new Map<string, Set<string>>();
  private invalidator?: (tags: string[]) => void;

  constructor(
    private readonly ttlMs = 30_000,
    readonly enabled = true,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error('[vela] presence ttlMs must be a positive safe integer');
    }
  }

  /** Wired by the engine so beats/reaps invalidate through the live driver. */
  bindInvalidator(invalidator: (tags: string[]) => void): void {
    this.invalidator = invalidator;
  }

  beat(room: string, clientId: string, meta?: unknown): void {
    if (!this.enabled) return;
    assertWebSocketRoomId(room);
    if (meta !== undefined) {
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(meta);
      } catch {
        throw new Error('[vela] presence metadata must be serializable JSON');
      }
      if (
        serialized === undefined ||
        encoder.encode(serialized).byteLength > MAX_PRESENCE_METADATA_BYTES
      ) {
        throw new Error(
          `[vela] presence metadata must not exceed ${MAX_PRESENCE_METADATA_BYTES} bytes`,
        );
      }
    }
    let state = this.rooms.get(room);
    if (!state) {
      state = { members: new Map() };
      this.rooms.set(room, state);
    }
    state.members.set(clientId, { meta, lastSeen: Date.now() });

    let joined = this.roomsByClient.get(clientId);
    if (!joined) {
      joined = new Set();
      this.roomsByClient.set(clientId, joined);
    }
    joined.add(room);

    this.invalidator?.([presenceTag(room)]);
  }

  /** Immediate departure on socket close — peers see it without a TTL wait. */
  reap(clientId: string): void {
    const joined = this.roomsByClient.get(clientId);
    if (!joined) return;
    this.roomsByClient.delete(clientId);
    for (const room of joined) {
      const state = this.rooms.get(room);
      if (!state) continue;
      state.members.delete(clientId);
      if (state.members.size === 0) this.rooms.delete(room);
      this.invalidator?.([presenceTag(room)]);
    }
  }

  roster(room: string): PresenceMember[] {
    const state = this.rooms.get(room);
    if (!state) return [];
    const oldestAlive = Date.now() - this.ttlMs;
    return [...state.members.entries()]
      .filter(([, member]) => member.lastSeen >= oldestAlive)
      .map(([id, member]) => ({ id, meta: member.meta, lastSeen: member.lastSeen }));
  }
}

/** The built-in resolver backing `$presence.roster`. Registered by `LiveModule` unless presence is disabled. */
@LiveResolver()
@Injectable()
export class PresenceResolver {
  constructor(@Inject(PresenceService) private readonly presence: PresenceService) {}

  @LiveQuery(PRESENCE_ROSTER_QUERY, {
    tags: (args: { room: string }) => [presenceTag(args.room)],
    parse: (args: unknown) => {
      const room = (args as { room?: unknown } | undefined)?.room;
      try {
        assertWebSocketRoomId(room);
      } catch {
        throw new Error("presence roster args require a non-empty 'room' string");
      }
      return { room };
    },
  })
  roster(args: { room: string }, context: LiveQueryContext): PresenceMember[] {
    if (!context.rooms.includes(args.room)) {
      throw new Error('presence roster room is not joined by this connection');
    }
    return this.presence.roster(args.room);
  }
}
