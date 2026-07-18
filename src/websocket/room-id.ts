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

/** One Durable Object instance per gateway + room, addressed by name. */
export function roomToDurableId(
  ns: DurableObjectNamespace,
  gatewayPath: string,
  roomId: string,
): DurableObjectId {
  return ns.idFromName(durableObjectRoomName(gatewayPath, roomId));
}
