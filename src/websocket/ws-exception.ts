import { toErrorBody, type Catalog } from '@velajs/errors';

/**
 * WebSocket analogue of `HttpException`. Thrown from guards/pipes/handlers to
 * signal a client-facing error; the dispatcher serializes it to an
 * `{ event: 'exception', data }` frame unless a matching exception filter
 * handles it first.
 */
export class WsException extends Error {
  constructor(private readonly err: string | Record<string, unknown>) {
    super(
      typeof err === 'string'
        ? err
        : String((err as Record<string, unknown>).message ?? 'WsException'),
    );
    this.name = 'WsException';
  }

  getError(): string | Record<string, unknown> {
    return this.err;
  }
}

/**
 * Default serialization of an uncaught error into the outbound exception frame.
 *
 * A `WsException` ships its own payload verbatim (string → `{ message }`,
 * object → as-is). Every other error routes through `toErrorBody` — the single
 * wire-redaction seam shared with the HTTP edge — so unbranded/internal errors
 * are redacted to their catalog title and only branded `VelaError`s echo a
 * client-safe `{ code, message, ... }`.
 */
export function toErrorFrame(
  error: unknown,
  catalog?: Catalog<string>,
): { event: 'exception'; data: unknown } {
  if (error instanceof WsException) {
    const e = error.getError();
    return { event: 'exception', data: typeof e === 'string' ? { message: e } : e };
  }
  const { body } = toErrorBody(error, { catalog });
  return { event: 'exception', data: body.error };
}
