/**
 * WebSocket analogue of `HttpException`. Thrown from guards/pipes/handlers to
 * signal a client-facing error; the dispatcher serializes it to an
 * `{ event: 'exception', data }` frame unless a matching exception filter
 * handles it first.
 */
export class WsException extends Error {
  constructor(private readonly err: string | Record<string, unknown>) {
    super(typeof err === 'string' ? err : String((err as Record<string, unknown>).message ?? 'WsException'));
    this.name = 'WsException';
  }

  getError(): string | Record<string, unknown> {
    return this.err;
  }
}

/** Default serialization of an uncaught error into the outbound exception frame. */
export function toErrorFrame(error: unknown): { event: 'exception'; data: unknown } {
  if (error instanceof WsException) {
    const e = error.getError();
    return { event: 'exception', data: typeof e === 'string' ? { message: e } : e };
  }
  return { event: 'exception', data: { message: 'Internal server error' } };
}
