// Minimal structural views of the Durable Object runtime, so the transport
// logic is unit-testable in Node with fakes. Real `DurableObjectState` and
// `WebSocket` (from @cloudflare/workers-types) satisfy these structurally.

export interface WsLike {
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
  /** Present on SQLite-backed DOs — the live cursor log lives here. */
  readonly storage?: { sql?: SqlStorageLike };
}

/** Per-connection metadata persisted in the hibernation attachment (≤ 16 KiB). */
export interface WsAttachment {
  connId: string;
  userId?: string;
  /** The gateway route path this socket belongs to — used to route messages. */
  path: string;
  /** Dynamically-joined room names (the hub room is also a hibernation tag). */
  rooms: string[];
  data: Record<string, unknown>;
}
