import { assertWebSocketRoomId, DEFAULT_WS_MAX_JOINED_ROOMS } from '@velajs/vela/websocket';
import type { WsAttachment, WsLike } from './do-state';

const record = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every((key) => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      return property !== undefined && 'value' in property;
    })
  );
};
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const text = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  new TextEncoder().encode(value).byteLength <= 2048;

/** Versionless 1.x records remain readable; malformed/future versions fail closed. */
export function readWsAttachment(value: unknown): WsAttachment | undefined {
  if (!record(value) || (value.version !== undefined && value.version !== 1)) return undefined;
  if (
    !text(value.connId) ||
    typeof value.path !== 'string' ||
    value.path.length > 8192 ||
    (value.state !== 'pending' && value.state !== 'active' && value.state !== 'rejected') ||
    !Array.isArray(value.rooms) ||
    value.rooms.length > DEFAULT_WS_MAX_JOINED_ROOMS ||
    !record(value.data)
  )
    return undefined;
  const rooms: string[] = [];
  for (let index = 0; index < value.rooms.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value.rooms, index);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string')
      return undefined;
    const room: string = descriptor.value;
    try {
      assertWebSocketRoomId(room);
    } catch {
      return undefined;
    }
    if (rooms.includes(room)) return undefined;
    rooms.push(room);
  }
  if (value.maxFrameBytes !== undefined && !positive(value.maxFrameBytes)) return undefined;
  if (value.expiresAtMs !== undefined && !positive(value.expiresAtMs)) return undefined;
  if (value.userId !== undefined && !text(value.userId)) return undefined;
  if (value.tenantId !== undefined && !text(value.tenantId)) return undefined;
  let principal: WsAttachment['principal'];
  if (value.principal !== undefined) {
    const p = value.principal;
    if (
      !record(p) ||
      !text(p.issuer) ||
      !text(p.subject) ||
      (p.principalType !== 'user' && p.principalType !== 'service')
    )
      return undefined;
    principal = { issuer: p.issuer, subject: p.subject, principalType: p.principalType };
    if (value.userId !== undefined && value.userId !== p.subject) return undefined;
  }
  return {
    version: 1,
    connId: value.connId,
    state: value.state,
    path: value.path,
    rooms,
    data: { ...value.data },
    ...(principal ? { principal } : {}),
    ...(typeof value.userId === 'string' ? { userId: value.userId } : {}),
    ...(typeof value.tenantId === 'string' ? { tenantId: value.tenantId } : {}),
    ...(typeof value.expiresAtMs === 'number' ? { expiresAtMs: value.expiresAtMs } : {}),
    ...(typeof value.maxFrameBytes === 'number' ? { maxFrameBytes: value.maxFrameBytes } : {}),
  };
}

export function socketAttachment(ws: WsLike): WsAttachment | undefined {
  try {
    return readWsAttachment(ws.deserializeAttachment());
  } catch {
    return undefined;
  }
}

export function rejectedAttachment(): WsAttachment {
  return { version: 1, connId: '', state: 'rejected', path: '', rooms: [], data: {} };
}
