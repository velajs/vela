// Minimal structural views of the Durable Object runtime, so the transport
// logic is unit-testable in Node with fakes. Real `DurableObjectState` and
// `WebSocket` (from @cloudflare/workers-types) satisfy these structurally.

export interface WsLike {
  send(message: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface DoStateLike {
  readonly id: { toString(): string; readonly name?: string | null };
  acceptWebSocket(ws: WsLike, tags?: string[]): void;
  getWebSockets(tag?: string): WsLike[];
  setWebSocketAutoResponse?(pair: unknown): void;
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
