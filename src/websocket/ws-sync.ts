import type { BroadcastCommand, WsClient } from './websocket.types';

/**
 * Owns LOCAL room membership and local fan-out for the connections a single
 * node/isolate holds. The Cloudflare transport backs this with hibernation
 * tags + attachment; node/bun/deno back it with the in-memory implementation
 * below. Always edge-safe (no `node:*`).
 */
export interface RoomRegistry {
  /** Register a connection (called on connect) so global broadcasts can reach it. */
  register(client: WsClient): void;
  join(client: WsClient, room: string): void | Promise<void>;
  leave(client: WsClient, room: string): void | Promise<void>;
  /** Remove a connection and all its room memberships (called on disconnect). */
  leaveAll(client: WsClient): void | Promise<void>;
  /** Deliver a command to the sockets THIS node holds, applying every exclusion. */
  deliverLocal(cmd: BroadcastCommand): void | Promise<void>;
  localIdsInRoom(room: string): string[];
}

/**
 * Pluggable cross-instance transport for broadcast commands. `local()` is the
 * zero-config single-instance default; `durableObject()` (Cloudflare) and
 * `redis()` (node) are additive and chosen at the composition root.
 */
export interface SyncDriver {
  readonly kind: string;
  /** Wire the local registry so the driver can deliver to locally-held sockets. */
  bind(registry: RoomRegistry): void;
  /** Route a command so every node that may hold a matching socket delivers it. */
  dispatch(cmd: BroadcastCommand): void | Promise<void>;
  countRoom?(room: string): Promise<number>;
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

/** Single-instance default: deliver straight to the local registry, no cross-node hop. */
export function local(): SyncDriver {
  let registry: RoomRegistry | undefined;
  return {
    kind: 'local',
    bind(r) {
      registry = r;
    },
    dispatch(cmd) {
      return registry?.deliverLocal(cmd);
    },
  };
}

/** In-memory `RoomRegistry` for node/bun/deno and tests. Edge-safe (plain Maps). */
export class InMemoryRoomRegistry implements RoomRegistry {
  private readonly rooms = new Map<string, Set<WsClient>>();
  private readonly clientRooms = new Map<string, Set<string>>();
  private readonly clients = new Map<string, WsClient>();

  register(client: WsClient): void {
    this.clients.set(client.id, client);
  }

  join(client: WsClient, room: string): void {
    this.register(client);
    let members = this.rooms.get(room);
    if (!members) {
      members = new Set();
      this.rooms.set(room, members);
    }
    members.add(client);

    let joined = this.clientRooms.get(client.id);
    if (!joined) {
      joined = new Set();
      this.clientRooms.set(client.id, joined);
    }
    joined.add(room);
  }

  leave(client: WsClient, room: string): void {
    const members = this.rooms.get(room);
    members?.delete(client);
    if (members && members.size === 0) this.rooms.delete(room);
    this.clientRooms.get(client.id)?.delete(room);
  }

  leaveAll(client: WsClient): void {
    for (const room of this.clientRooms.get(client.id) ?? []) {
      const members = this.rooms.get(room);
      members?.delete(client);
      if (members && members.size === 0) this.rooms.delete(room);
    }
    this.clientRooms.delete(client.id);
    this.clients.delete(client.id);
  }

  localIdsInRoom(room: string): string[] {
    return [...(this.rooms.get(room) ?? [])].map((c) => c.id);
  }

  deliverLocal(cmd: BroadcastCommand): void {
    const excludeIds = new Set(cmd.exceptIds ?? []);
    const excludeRooms = cmd.exceptRooms ?? [];

    // Empty `rooms` => GLOBAL: every registered connection. Otherwise the union
    // of the targeted rooms' members (deduped per connection).
    const candidates =
      cmd.rooms.length === 0
        ? new Set(this.clients.values())
        : (() => {
            const set = new Set<WsClient>();
            for (const room of cmd.rooms) {
              for (const client of this.rooms.get(room) ?? []) set.add(client);
            }
            return set;
          })();

    for (const client of candidates) {
      if (excludeIds.has(client.id)) continue;
      const joined = this.clientRooms.get(client.id);
      if (excludeRooms.some((room) => joined?.has(room))) continue;
      client.sendRaw(cmd.frame);
    }
  }
}
