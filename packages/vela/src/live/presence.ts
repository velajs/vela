import { MAX_PRESENCE_METADATA_BYTES, defineLiveQuery } from '@velajs/live-protocol';
import { Inject } from '../container/decorators';
import { assertWebSocketRoomId } from '../websocket/gateway-routing';
import { LiveQuery, LiveResolver } from './live.decorators';
import type { LiveQueryContext } from './live.types';
import { sha256Hex } from './sha256';

const encoder = new TextEncoder();

/**
 * The invalidation tag for one gateway room's roster: `$presence:` and the
 * SHA-256 hex digest of the JSON `[gatewayPath, room]`. `$`-prefixed, it never
 * collides with app tags; the gateway path keeps rooms that share an id
 * across gateways apart; the digest keeps every valid room id (up to 512
 * bytes) on any gateway path within the 256-byte bound of an invalidation tag.
 */
export const presenceTag = (gatewayPath: string, room: string): string => {
  assertWebSocketRoomId(room);
  return `$presence:${sha256Hex(JSON.stringify([gatewayPath, room]))}`;
};

/** One gateway room's key in the presence service's scope. */
const roomKey = (gatewayPath: string, room: string): string => JSON.stringify([gatewayPath, room]);

/** The built-in roster query name (`useLiveQuery`-able like any app query). */
export const PRESENCE_ROSTER_QUERY = '$presence.roster';

/** One present connection as returned by the roster query. Keyed by `id` so list deltas apply. */
export interface PresenceMember {
  /** The connection id that heartbeats this membership. */
  id: string;
  meta?: unknown;
  lastSeen: number;
}

const presenceRosterDefinition = defineLiveQuery({
  name: PRESENCE_ROSTER_QUERY,
  args: {
    parse(value: unknown): { room: string } {
      const room =
        typeof value === 'object' && value !== null && 'room' in value ? value.room : undefined;
      try {
        assertWebSocketRoomId(room);
      } catch {
        throw new Error("presence roster args require a non-empty 'room' string");
      }
      return { room };
    },
  },
  result: {
    parse(value: unknown): PresenceMember[] {
      if (!Array.isArray(value)) throw new TypeError('presence roster must be an array');
      return value.map((member: unknown) => {
        if (
          typeof member !== 'object' ||
          member === null ||
          !('id' in member) ||
          typeof member.id !== 'string' ||
          !('lastSeen' in member) ||
          typeof member.lastSeen !== 'number' ||
          !Number.isSafeInteger(member.lastSeen)
        ) {
          throw new TypeError('invalid presence roster member');
        }
        return {
          id: member.id,
          lastSeen: member.lastSeen,
          ...('meta' in member ? { meta: member.meta } : {}),
        };
      });
    },
  },
});

interface RoomState {
  room: string;
  /** The roster's invalidation tag, derived once per occupied gateway room. */
  tag: string;
  members: Map<string, { meta?: unknown; lastSeen: number }>;
}

/**
 * The presence preset's server half. Heartbeats arrive as `{ t: 'presence' }`
 * frames on the live socket (routed here by the engine); the roster is a
 * built-in live query invalidated per gateway room. Departure is immediate:
 * the WS close hook reaps the member without waiting out the TTL. Staleness
 * (an ungraceful drop the transport never noticed) is filtered AT READ TIME —
 * no timers, per the edge rules (`setInterval` is forbidden).
 *
 * A roster belongs to one gateway room: the gateway's path and the room id,
 * so gateways whose rooms share an id keep separate rosters. It lives in this
 * log scope (one process on node, one room-DO on Cloudflare — where it is
 * exactly the room's roster).
 */
export class PresenceService {
  // Keyed by roomKey(gatewayPath, room): one entry per gateway room.
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

  beat(gatewayPath: string, room: string, clientId: string, meta?: unknown): void {
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
    const key = roomKey(gatewayPath, room);
    let state = this.rooms.get(key);
    if (!state) {
      state = { room, tag: presenceTag(gatewayPath, room), members: new Map() };
      this.rooms.set(key, state);
    }
    state.members.set(clientId, { meta, lastSeen: Date.now() });

    let joined = this.roomsByClient.get(clientId);
    if (!joined) {
      joined = new Set();
      this.roomsByClient.set(clientId, joined);
    }
    joined.add(key);

    this.invalidator?.([state.tag]);
  }

  /** Immediate departure on socket close — peers see it without a TTL wait. */
  reap(clientId: string): void {
    const joined = this.roomsByClient.get(clientId);
    if (!joined) return;
    this.roomsByClient.delete(clientId);
    for (const key of joined) {
      const state = this.rooms.get(key);
      if (!state) continue;
      state.members.delete(clientId);
      if (state.members.size === 0) this.rooms.delete(key);
      this.invalidator?.([state.tag]);
    }
  }

  /** The live members of one gateway room. */
  roster(gatewayPath: string, room: string): PresenceMember[] {
    assertWebSocketRoomId(room);
    const state = this.rooms.get(roomKey(gatewayPath, room));
    return state ? this.alive(state) : [];
  }

  /**
   * Occupied rooms in this service's scope, each room once with the members
   * of every gateway that uses its id. Expired memberships and metadata are
   * omitted.
   */
  inspectRooms(): Array<{ room: string; count: number; members: string[] }> {
    const occupied = new Map<string, string[]>();
    for (const state of this.rooms.values()) {
      const members = this.alive(state).map((member) => member.id);
      if (members.length)
        occupied.set(state.room, [...(occupied.get(state.room) ?? []), ...members]);
    }
    return [...occupied].map(([room, members]) => ({ room, count: members.length, members }));
  }

  private alive(state: RoomState): PresenceMember[] {
    const oldestAlive = Date.now() - this.ttlMs;
    return [...state.members.entries()]
      .filter(([, member]) => member.lastSeen >= oldestAlive)
      .map(([id, member]) => ({ id, meta: member.meta, lastSeen: member.lastSeen }));
  }
}

/** The built-in resolver backing `$presence.roster`. Registered by `LiveModule` unless presence is disabled. */
@LiveResolver()
export class PresenceResolver {
  constructor(@Inject(PresenceService) private readonly presence: PresenceService) {}

  @LiveQuery(presenceRosterDefinition, {
    tags: (args, context) => [presenceTag(context.path, args.room)],
  })
  roster(args: { room: string }, context: LiveQueryContext): PresenceMember[] {
    if (!context.rooms.includes(args.room)) {
      throw new Error('presence roster room is not joined by this connection');
    }
    return this.presence.roster(context.path, args.room);
  }
}
