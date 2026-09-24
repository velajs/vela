// Minimal structural views of the Durable Object runtime, so the transport
// logic is unit-testable in Node with fakes. Real `DurableObjectState` and
// `WebSocket` (from @cloudflare/workers-types) satisfy these structurally.

/** Cloudflare's serialized WebSocket hibernation attachment ceiling. */
export const MAX_WS_ATTACHMENT_BYTES = 16_384;

export interface WsLike {
  readonly readyState?: number;
  readonly bufferedAmount?: number;
  send(message: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** Structural view of the DO's SQLite handle (`ctx.storage.sql`, requires `new_sqlite_classes`). */
export interface SqlStorageLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export interface DoStateLike {
  readonly id: { toString(): string; readonly name?: string | null };
  acceptWebSocket(ws: WsLike, tags?: string[]): void;
  getWebSockets(tag?: string): WsLike[];
  setWebSocketAutoResponse?(pair: unknown): void;
  /**
   * workerd exposes `sql` on every class, but its statements throw unless the
   * class is SQLite-backed (`new_sqlite_classes`), where the live cursor log lives.
   */
  readonly storage?: { sql?: SqlStorageLike };
}

/** Per-connection metadata persisted in the hibernation attachment (≤ 16 KiB). */
export interface WsAttachment {
  /** Absent on 1.x attachments created before versioned validation. */
  version?: 1;
  connId: string;
  /** Only active sockets may dispatch frames or receive fan-out. */
  state: 'pending' | 'active' | 'rejected';
  userId?: string;
  /** Verified, issuer-qualified connection principal. */
  principal?: {
    issuer: string;
    subject: string;
    principalType: 'user' | 'service';
  };
  /** Trusted server-derived tenant boundary for this connection. */
  tenantId?: string;
  /** Verified auth credential expiry in epoch milliseconds. */
  expiresAtMs?: number;
  /** The gateway route path this socket belongs to — used to route messages. */
  path: string;
  /** Validated inbound/outbound gateway frame ceiling, persisted across hibernation. */
  maxFrameBytes?: number;
  /** Dynamically-joined room names (the hub room is also a hibernation tag). */
  rooms: string[];
  data: Record<string, unknown>;
}
