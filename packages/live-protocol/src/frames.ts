/**
 * The normative frame catalog for Vela live queries.
 *
 * Live frames ride Vela's existing WebSocket envelope `{ event, data }` under
 * the single reserved event name `$live`; the frame itself is the envelope's
 * `data`, discriminated on `t`. Classic gateway events, `$ping`→`$pong`
 * keepalive, and live frames coexist on one socket. The `$` prefix is reserved
 * for the framework: app gateways must never register a `$…` event.
 *
 * Byte-identical encoding matters: golden fixtures pin the exact wire string
 * for every frame shape, and both the server and the client encode through
 * {@link encodeLiveFrame} / {@link encodeLiveEnvelope} so the two sides cannot
 * drift. Canonical key order is the declaration order of each type below;
 * absent optionals are omitted entirely.
 */
import { LIVE_PROTOCOL } from './version';
import { readWebSocketEnvelope } from './envelope';

/** The reserved envelope event every live frame rides under. */
export const LIVE_EVENT = '$live';

/**
 * The reserved event-name prefix. The WS dispatcher rejects app gateways that
 * register a `$…` event at bootstrap so live (and future framework) frames can
 * never collide with app events.
 */
export const RESERVED_EVENT_PREFIX = '$';

/**
 * HTTP response headers carrying the commit cursor/epoch of the log scope a
 * mutation's invalidations landed in. The client gates optimistic-layer drops
 * on a subscription frame whose `cursor` passes this value (and whose `epoch`
 * matches) — never on HTTP response timing, which races the broadcast.
 */
export const COMMIT_CURSOR_HEADER = 'Vela-Commit-Cursor';
export const COMMIT_EPOCH_HEADER = 'Vela-Commit-Epoch';

/** Default hard limits shared by every live-protocol endpoint. */
export const MAX_LIVE_FRAME_BYTES = 64 * 1024;
export const MAX_PRESENCE_METADATA_BYTES = 4 * 1024;
export const MAX_DELTA_OPS = 1000;

/** Well-known `error` frame codes. The code space is open — receivers must tolerate unknown codes. */
export const LIVE_ERROR_CODES = {
  UNSUPPORTED_PROTOCOL: 'unsupported_protocol',
  DUPLICATE_SUB: 'duplicate_sub',
  UNKNOWN_QUERY: 'unknown_query',
  FORBIDDEN: 'forbidden',
  BAD_ARGS: 'bad_args',
  LIMIT_EXCEEDED: 'limit_exceeded',
  INTERNAL: 'internal',
} as const;

export type LiveErrorCode =
  | (typeof LIVE_ERROR_CODES)[keyof typeof LIVE_ERROR_CODES]
  | (string & {});

/**
 * One row change inside a `delta` frame. Ops are keyed by the query's key
 * field (default `'id'`); `insert`/`update` carry the full new row, `delete`
 * omits it. An `insert` carries `before` — the key of the row it precedes in
 * the authoritative result (`null` = append) — so the client reconstructs the
 * server's ordering exactly. Application is idempotent: `insert` on an
 * existing key replaces in place, `delete` of an absent key is a no-op.
 */
export type RowOp =
  | { op: 'insert'; key: string; row: Record<string, unknown>; before: string | null }
  | { op: 'update'; key: string; row: Record<string, unknown> }
  | { op: 'delete'; key: string };

/** Client → server frames (the `data` of a `{ event: '$live' }` envelope). */
export type ClientLiveFrame =
  | {
      t: 'sub';
      /** Client-chosen subscription id, unique per socket. */
      sub: string;
      /** The live-query name its `defineLiveQuery({ name })` declares. */
      query: string;
      args?: unknown;
      /** Resume watermark: last observed cursor/epoch. Omitted = cold subscribe. */
      sinceCursor?: number;
      sinceEpoch?: string;
      /** Key-field override for list deltas (default `'id'`). */
      key?: string;
      /** Protocol version the client speaks (see LIVE_PROTOCOL). */
      v: number;
    }
  | { t: 'unsub'; sub: string }
  | { t: 'presence'; room: string; meta?: unknown };

/** Server → client frames. `ack` precedes any `data`/`resume` for a sub. */
export type ServerLiveFrame =
  | { t: 'ack'; sub: string }
  | { t: 'data'; sub: string; snapshot: unknown; cursor?: number; epoch?: string }
  | { t: 'delta'; sub: string; ops: RowOp[]; cursor?: number; epoch?: string }
  /** Re-run result was byte-identical — no payload, but the cursor still advances (drops optimistic layers). */
  | { t: 'settled'; sub: string; cursor?: number; epoch?: string }
  /** Resume verdict: nothing relevant changed while away — keep the cached value, advance the cursor. */
  | { t: 'resume'; sub: string; cursor: number; epoch: string }
  | { t: 'error'; sub?: string; code: LiveErrorCode; message: string; fatal: boolean };

export type LiveFrame = ClientLiveFrame | ServerLiveFrame;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCursor = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isBoundedString = (value: unknown, max: number, allowEmpty = false): value is string =>
  typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= max;

const isOptionalBoundedString = (value: unknown, max: number): value is string | undefined =>
  value === undefined || isBoundedString(value, max);

const hasOwn = (value: Record<string, unknown>, key: string): boolean => Object.hasOwn(value, key);

const hasCursorPair = (value: Record<string, unknown>, cursor: string, epoch: string): boolean =>
  (value[cursor] === undefined && value[epoch] === undefined) ||
  (isCursor(value[cursor]) && isBoundedString(value[epoch], 256));

/** Structural guard for a single {@link RowOp}. Unknown extra fields are tolerated. */
export const isRowOp = (value: unknown): value is RowOp => {
  if (
    !isRecord(value) ||
    !isJsonWithin(value, MAX_LIVE_FRAME_BYTES) ||
    !isBoundedString(value['key'], 512)
  ) {
    return false;
  }
  const op = value['op'];
  if (op === 'delete') return true;
  if (op !== 'insert' && op !== 'update') return false;
  if (!isRecord(value['row'])) return false;
  if (op === 'insert') {
    const before = value['before'];
    return before === null || isBoundedString(before, 512);
  }
  return true;
};

export const isRowOps = (value: unknown): value is RowOp[] =>
  Array.isArray(value) &&
  value.length <= MAX_DELTA_OPS &&
  isJsonWithin(value, MAX_LIVE_FRAME_BYTES) &&
  value.every(isRowOp);

/**
 * Structural guard for a client frame. Frames with an unknown `t` return
 * false — per the forward-compat rule the receiver then ignores the frame.
 */
export const isClientLiveFrame = (value: unknown): value is ClientLiveFrame => {
  if (!isRecord(value) || !isJsonWithin(value, MAX_LIVE_FRAME_BYTES)) return false;
  switch (value['t']) {
    case 'sub':
      return (
        isBoundedString(value['sub'], 256) &&
        isBoundedString(value['query'], 256) &&
        hasCursorPair(value, 'sinceCursor', 'sinceEpoch') &&
        isOptionalBoundedString(value['key'], 128) &&
        value['v'] === LIVE_PROTOCOL &&
        (!hasOwn(value, 'args') || isJsonWithin(value['args'], 32 * 1024))
      );
    case 'unsub':
      return isBoundedString(value['sub'], 256);
    case 'presence':
      return (
        isBoundedString(value['room'], 512) &&
        (!hasOwn(value, 'meta') || isJsonWithin(value['meta'], MAX_PRESENCE_METADATA_BYTES))
      );
    default:
      return false;
  }
};

/** Structural guard for a server frame. Unknown `t` → false (receiver ignores). */
export const isServerLiveFrame = (value: unknown): value is ServerLiveFrame => {
  if (!isRecord(value) || !isJsonWithin(value, MAX_LIVE_FRAME_BYTES)) return false;
  switch (value['t']) {
    case 'ack':
      return isBoundedString(value['sub'], 256);
    case 'data':
      return (
        isBoundedString(value['sub'], 256) &&
        hasOwn(value, 'snapshot') &&
        hasCursorPair(value, 'cursor', 'epoch')
      );
    case 'delta':
      return (
        isBoundedString(value['sub'], 256) &&
        isRowOps(value['ops']) &&
        hasCursorPair(value, 'cursor', 'epoch')
      );
    case 'settled':
      return isBoundedString(value['sub'], 256) && hasCursorPair(value, 'cursor', 'epoch');
    case 'resume':
      return (
        isBoundedString(value['sub'], 256) &&
        isCursor(value['cursor']) &&
        isBoundedString(value['epoch'], 256)
      );
    case 'error':
      return (
        isOptionalBoundedString(value['sub'], 256) &&
        isBoundedString(value['code'], 128) &&
        isBoundedString(value['message'], 2048, true) &&
        typeof value['fatal'] === 'boolean'
      );
    default:
      return false;
  }
};

/**
 * Extract the live frame from a parsed WS envelope, or `undefined` when the
 * envelope is not a live envelope. Does NOT validate the frame — pair with
 * {@link isClientLiveFrame} / {@link isServerLiveFrame} on the receiving side.
 */
export const readLiveEnvelope = (envelope: unknown): unknown => {
  if (
    !isRecord(envelope) ||
    !readWebSocketEnvelope(envelope) ||
    envelope['event'] !== LIVE_EVENT ||
    !hasOwn(envelope, 'data') ||
    !isJsonWithin(envelope, MAX_LIVE_FRAME_BYTES)
  ) {
    return undefined;
  }
  return envelope['data'];
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const UTF8_ENCODER = new TextEncoder();

const isJsonWithin = (value: unknown, maxBytes: number): boolean => {
  try {
    if (!isJsonValue(value, new WeakSet(), { nodes: 0 }, 0)) return false;
    const serialized = JSON.stringify(value);
    return serialized !== undefined && UTF8_ENCODER.encode(serialized).byteLength <= maxBytes;
  } catch {
    return false;
  }
};

const isJsonValue = (
  value: unknown,
  seen: WeakSet<object>,
  budget: { nodes: number },
  depth: number,
): boolean => {
  budget.nodes += 1;
  if (budget.nodes > 10_000 || depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);

  const values: unknown[] = [];
  if (Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Array.prototype && prototype !== null) return false;
    if (value.length > 10_000 - budget.nodes) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        return false;
      }
      const child: unknown = descriptor.value;
      values.push(child);
    }
    // Sparse arrays serialize holes as null, which changes the source value.
    if (values.length !== value.length) return false;
  } else if (isRecord(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || DANGEROUS_KEYS.has(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      // Wire JSON has data properties. Never execute application getters while
      // checking an unknown value; they can throw or change between reads.
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        return false;
      }
      const child: unknown = descriptor.value;
      values.push(child);
    }
  } else {
    return false;
  }

  for (const child of values) {
    if (!isJsonValue(child, seen, budget, depth + 1)) return false;
  }
  seen.delete(value);
  return true;
};

/** Wrap a frame in the `$live` envelope object. */
export const liveEnvelope = (frame: LiveFrame): { event: typeof LIVE_EVENT; data: LiveFrame } => ({
  event: LIVE_EVENT,
  data: frame,
});

const unreachableVariant = (value: never): never => {
  throw new TypeError(`Unknown live protocol variant: ${JSON.stringify(value)}`);
};

const canonicalRowOp = (op: RowOp): RowOp => {
  switch (op.op) {
    case 'insert':
      return { op: op.op, key: op.key, row: op.row, before: op.before };
    case 'update':
      return { op: op.op, key: op.key, row: op.row };
    case 'delete':
      return { op: op.op, key: op.key };
    default:
      return unreachableVariant(op);
  }
};

/**
 * Rebuild a frame with the canonical key order, dropping absent optionals.
 * `JSON.stringify` of the result is the frame's canonical wire form — the one
 * the golden fixtures pin byte-for-byte.
 */
export const canonicalLiveFrame = (frame: LiveFrame): LiveFrame => {
  switch (frame.t) {
    case 'sub':
      return {
        t: frame.t,
        sub: frame.sub,
        query: frame.query,
        ...(frame.args === undefined ? {} : { args: frame.args }),
        ...(frame.sinceCursor === undefined ? {} : { sinceCursor: frame.sinceCursor }),
        ...(frame.sinceEpoch === undefined ? {} : { sinceEpoch: frame.sinceEpoch }),
        ...(frame.key === undefined ? {} : { key: frame.key }),
        v: frame.v,
      };
    case 'unsub':
    case 'ack':
      return { t: frame.t, sub: frame.sub };
    case 'presence':
      return {
        t: frame.t,
        room: frame.room,
        ...(frame.meta === undefined ? {} : { meta: frame.meta }),
      };
    case 'data':
      return {
        t: frame.t,
        sub: frame.sub,
        snapshot: frame.snapshot,
        ...(frame.cursor === undefined ? {} : { cursor: frame.cursor }),
        ...(frame.epoch === undefined ? {} : { epoch: frame.epoch }),
      };
    case 'delta':
      return {
        t: frame.t,
        sub: frame.sub,
        ops: frame.ops.map(canonicalRowOp),
        ...(frame.cursor === undefined ? {} : { cursor: frame.cursor }),
        ...(frame.epoch === undefined ? {} : { epoch: frame.epoch }),
      };
    case 'settled':
      return {
        t: frame.t,
        sub: frame.sub,
        ...(frame.cursor === undefined ? {} : { cursor: frame.cursor }),
        ...(frame.epoch === undefined ? {} : { epoch: frame.epoch }),
      };
    case 'resume':
      return { t: frame.t, sub: frame.sub, cursor: frame.cursor, epoch: frame.epoch };
    case 'error':
      return {
        t: frame.t,
        ...(frame.sub === undefined ? {} : { sub: frame.sub }),
        code: frame.code,
        message: frame.message,
        fatal: frame.fatal,
      };
    default:
      return unreachableVariant(frame);
  }
};

/** Canonical JSON encoding of a bare frame (no envelope). */
export const encodeLiveFrame = (frame: LiveFrame): string => {
  if (!isClientLiveFrame(frame) && !isServerLiveFrame(frame)) {
    throw new TypeError('Cannot encode an invalid or oversized live frame.');
  }
  return JSON.stringify(canonicalLiveFrame(frame));
};

/**
 * Canonical JSON encoding of the full `$live` envelope — what actually goes
 * on the socket. The shared 64 KiB limit applies to this complete wire value,
 * matching {@link readLiveEnvelope} and receiver-side raw-frame checks.
 */
export const encodeLiveEnvelope = (frame: LiveFrame): string => {
  const encoded = `{"event":${JSON.stringify(LIVE_EVENT)},"data":${encodeLiveFrame(frame)}}`;
  if (UTF8_ENCODER.encode(encoded).byteLength > MAX_LIVE_FRAME_BYTES) {
    throw new TypeError('Cannot encode an oversized live envelope.');
  }
  return encoded;
};
