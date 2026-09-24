import type { BroadcastCommand, WsClient } from './websocket.types';
import {
  DEFAULT_WS_MAX_FRAME_BYTES,
  resolveMaxFrameBytes,
  webSocketFrameFits,
} from './gateway-routing';

const MAX_BROADCAST_VECTOR_ITEMS = 256;
const MAX_BROADCAST_SELECTOR_BYTES = 512;
/** Bounded room/exclusion metadata allowance beyond the actual WS frame. */
export const MAX_WS_SYNC_ENVELOPE_OVERHEAD_BYTES = 64 * 1024;
const encoder = new TextEncoder();

function isBoundedStringVector(value: unknown, required: boolean): value is string[] | undefined {
  if (value === undefined) return !required;
  return (
    Array.isArray(value) &&
    value.length <= MAX_BROADCAST_VECTOR_ITEMS &&
    value.every(
      (item) =>
        typeof item === 'string' &&
        item.length > 0 &&
        encoder.encode(item).byteLength <= MAX_BROADCAST_SELECTOR_BYTES,
    )
  );
}

/** Runtime validation for commands crossing Redis/DO synchronization boundaries. */
export function broadcastCommandFits(
  value: unknown,
  maxFrameBytes = DEFAULT_WS_MAX_FRAME_BYTES,
): value is BroadcastCommand {
  if (!value || typeof value !== 'object') return false;
  const command = value as Partial<BroadcastCommand>;
  return (
    isBoundedStringVector(command.rooms, true) &&
    isBoundedStringVector(command.exceptRooms, false) &&
    isBoundedStringVector(command.exceptIds, false) &&
    (command.origin === undefined ||
      (typeof command.origin === 'string' &&
        command.origin.length > 0 &&
        encoder.encode(command.origin).byteLength <= MAX_BROADCAST_SELECTOR_BYTES)) &&
    (command.gatewayPath === undefined ||
      (typeof command.gatewayPath === 'string' &&
        encoder.encode(command.gatewayPath).byteLength <= MAX_BROADCAST_SELECTOR_BYTES)) &&
    typeof command.frame === 'string' &&
    webSocketFrameFits(command.frame, maxFrameBytes)
  );
}

export function assertBroadcastCommandFits(
  value: unknown,
  maxFrameBytes = DEFAULT_WS_MAX_FRAME_BYTES,
): asserts value is BroadcastCommand {
  if (!broadcastCommandFits(value, maxFrameBytes)) {
    throw new RangeError(
      `WebSocket broadcast command is invalid or exceeds ${maxFrameBytes} frame bytes`,
    );
  }
}

/** Bound the serialized bus envelope before JSON.parse/publish allocations fan out. */
export function webSocketSyncEnvelopeFits(serialized: string, maxFrameBytes: number): boolean {
  const resolved = resolveMaxFrameBytes({ maxFrameBytes });
  const envelopeLimit = Math.min(
    Number.MAX_SAFE_INTEGER,
    resolved + MAX_WS_SYNC_ENVELOPE_OVERHEAD_BYTES,
  );
  return webSocketFrameFits(serialized, envelopeLimit);
}

function deliverFrame(client: WsClient, frame: string): void {
  const maxFrameBytes = client.maxFrameBytes ?? DEFAULT_WS_MAX_FRAME_BYTES;
  if (!webSocketFrameFits(frame, maxFrameBytes)) {
    try {
      client.close(1009, 'Message too large');
    } catch {
      // already closed
    }
    return;
  }
  client.sendRaw(frame);
}

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
  /**
   * Deliver a command to the sockets THIS node holds, applying every exclusion
   * and, when the command names one, only to its gateway's sockets.
   */
  deliverLocal(cmd: BroadcastCommand): void | Promise<void>;
  /** Install the runtime's per-recipient guard recheck before fan-out. */
  setDeliveryAuthorizer?(authorizer: (client: WsClient) => boolean | Promise<boolean>): void;
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
  /** @internal Configure the largest explicitly declared gateway frame. */
  setMaxFrameBytes?(maxFrameBytes: number): void;
  countRoom?(room: string): Promise<number>;
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

/** Single-instance default: deliver straight to the local registry, no cross-node hop. */
export function local(): SyncDriver {
  let registry: RoomRegistry | undefined;
  let maxFrameBytes = DEFAULT_WS_MAX_FRAME_BYTES;
  return {
    kind: 'local',
    bind(r) {
      registry = r;
    },
    dispatch(cmd) {
      assertBroadcastCommandFits(cmd, maxFrameBytes);
      return registry?.deliverLocal(cmd);
    },
    setMaxFrameBytes(value) {
      maxFrameBytes = resolveMaxFrameBytes({ maxFrameBytes: value });
    },
  };
}

/** In-memory `RoomRegistry` for node/bun/deno and tests. Edge-safe (plain Maps). */
export class InMemoryRoomRegistry implements RoomRegistry {
  private readonly rooms = new Map<string, Set<WsClient>>();
  private readonly clientRooms = new Map<string, Set<string>>();
  private readonly clients = new Map<string, WsClient>();
  private deliveryAuthorizer?: (client: WsClient) => boolean | Promise<boolean>;

  setDeliveryAuthorizer(authorizer: (client: WsClient) => boolean | Promise<boolean>): void {
    this.deliveryAuthorizer = authorizer;
  }

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

  deliverLocal(cmd: BroadcastCommand): void | Promise<void> {
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

    const selected: WsClient[] = [];
    for (const client of candidates) {
      // A gateway-scoped push skips sockets of other gateways sharing a room id.
      if (cmd.gatewayPath !== undefined && client.path !== cmd.gatewayPath) continue;
      if (excludeIds.has(client.id)) continue;
      const joined = this.clientRooms.get(client.id);
      if (excludeRooms.some((room) => joined?.has(room))) continue;
      selected.push(client);
    }

    if (!this.deliveryAuthorizer) {
      for (const client of selected) deliverFrame(client, cmd.frame);
      return;
    }
    return Promise.all(
      selected.map(async (client) => {
        let allowed = false;
        try {
          allowed = (await this.deliveryAuthorizer!(client)) === true;
        } catch {
          allowed = false;
        }
        if (allowed) deliverFrame(client, cmd.frame);
        else {
          this.leaveAll(client);
          client.close(1008, 'delivery authorization revoked');
        }
      }),
    ).then(() => undefined);
  }
}
