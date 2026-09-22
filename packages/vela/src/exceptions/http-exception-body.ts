import { codeForStatus, toErrorBody, VelaError, type Catalog } from '@velajs/errors';
import type { HttpException } from '../errors/http-exception';

/**
 * The client-bound body for an {@link HttpException}, shared by every HTTP edge
 * (handler, middleware, `onError`). Object responses ship verbatim (crud
 * envelope compat). String responses become the canonical
 * `{ error: { code, message } }` through `toErrorBody`, with the code derived
 * from the status. Only a 4xx is a client fault whose text is meant for the
 * caller; a 5xx (or any other status, whose code resolves to `internal`) is
 * redacted to the status title.
 */
export const httpExceptionBody = (
  error: HttpException,
  catalog: Catalog<string>,
): { body: Record<string, unknown>; status: number } => {
  const status = error.getStatus();
  const raw = error.getRawResponse() ?? error.message;
  if (typeof raw !== 'string') return { body: raw, status };
  if (status < 400 || status >= 500) return toErrorBody(error, { catalog, fallbackStatus: status });
  return toErrorBody(new VelaError(codeForStatus(status), { message: raw, status }), { catalog });
};
