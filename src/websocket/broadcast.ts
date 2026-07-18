import {
  assertBroadcastCommandFits,
  DEFAULT_WS_MAX_FRAME_BYTES,
  resolveMaxFrameBytes,
} from '@velajs/vela/websocket';
import type { BroadcastCommand } from '@velajs/vela/websocket';
import { roomToDurableId } from './room-id';

interface WsBroadcastStub {
  broadcast(cmd: BroadcastCommand): Promise<void>;
}

/**
 * Push to a room from a Worker HTTP handler / cron / queue consumer (server-
 * initiated emit). Resolves the room's Durable Object and calls its `broadcast`
 * RPC method — the same canonical room→DO mapping the upgrade route uses, so it
 * always reaches the DO holding those sockets.
 *
 * @example
 * ```ts
 * // In a controller — ns from DurableObjectService.namespace
 * await broadcastToRoom(ns, '/orgs/:orgId/ws', `org:${id}`, 'order.created', order);
 * ```
 */
export async function broadcastToRoom(
  ns: DurableObjectNamespace,
  gatewayPath: string,
  room: string,
  event: string,
  data?: unknown,
  options?: { exceptIds?: string[]; maxFrameBytes?: number },
): Promise<void> {
  const cmd: BroadcastCommand = {
    rooms: [room],
    exceptIds: options?.exceptIds,
    frame: JSON.stringify({ event, data }),
  };
  const maxFrameBytes = resolveMaxFrameBytes({
    maxFrameBytes: options?.maxFrameBytes ?? DEFAULT_WS_MAX_FRAME_BYTES,
  });
  assertBroadcastCommandFits(cmd, maxFrameBytes);
  const stub = ns.get(roomToDurableId(ns, gatewayPath, room)) as unknown as WsBroadcastStub;
  await stub.broadcast(cmd);
}
