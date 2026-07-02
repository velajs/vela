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

/** One Durable Object instance per room, addressed by name. */
export function roomToDurableId(ns: DurableObjectNamespace, roomId: string): DurableObjectId {
  return ns.idFromName(roomId);
}
