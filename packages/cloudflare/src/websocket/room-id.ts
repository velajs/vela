// Canonical room ↔ Durable Object mappings. The SAME functions are used by the
// Worker upgrade route (to pick the DO) and by every server-initiated emit — so
// a connection and a later broadcast always resolve to the same DO instance.

/** Hibernation tag marking a socket's hub room (set at accept; immutable after). */
export function roomTag(roomId: string): string {
  return `room:${roomId}`;
}

/** Hibernation tag addressing one connection directly. */
export function connTag(connId: string): string {
  return `conn:${connId}`;
}

const DO_ROOM_NAME_PREFIX = 'vela:ws:v2:';
const MAX_DO_ROOM_NAME_BYTES = 1_024;
const encoder = new TextEncoder();

/** Stable, collision-free Durable Object name for one gateway's room. */
export function durableObjectRoomName(gatewayPath: string, roomId: string): string {
  if (
    typeof gatewayPath !== 'string' ||
    gatewayPath.length === 0 ||
    typeof roomId !== 'string' ||
    roomId.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(gatewayPath) ||
    /[\u0000-\u001f\u007f]/.test(roomId)
  ) {
    throw new Error('A non-empty, control-free gateway path and room id are required');
  }
  const name = `${DO_ROOM_NAME_PREFIX}${encodeURIComponent(gatewayPath)}:${encodeURIComponent(roomId)}`;
  if (encoder.encode(name).byteLength > MAX_DO_ROOM_NAME_BYTES) {
    throw new Error('The gateway/room Durable Object name exceeds 1024 bytes');
  }
  return name;
}

// A path parameter (`:name`): a gateway declares roomParam exactly when its
// path has one, which WsDispatcher validates at bootstrap.
const PATH_PARAM = /:[A-Za-z_]/;

/**
 * The room whose Durable Object holds `room` of the gateway at `gatewayPath`.
 * A gateway without roomParam (its path has no parameters) admits every
 * upgrade into one room, its path, so each room it names lives in that object;
 * upgrades, `Gateways` pushes and live invalidations resolve the same way.
 */
export function gatewayObjectRoom(gatewayPath: string, room: string): string {
  return PATH_PARAM.test(gatewayPath) ? room : gatewayPath;
}

/** One Durable Object instance per gateway + room, addressed by name. */
export function roomToDurableId(
  ns: Pick<DurableObjectNamespace, 'idFromName'>,
  gatewayPath: string,
  roomId: string,
): DurableObjectId {
  return ns.idFromName(durableObjectRoomName(gatewayPath, roomId));
}
