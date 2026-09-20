import { CORE_CATALOG, isVelaError, type Catalog, type ErrorBodyResult } from '@velajs/errors';
import { HTTPException } from 'hono/http-exception';
import type { Container } from '../container/container';
import { HttpException } from '../errors/http-exception';
import { APP_EXCEPTION_HANDLER, ERROR_CATALOG } from '../pipeline/tokens';
import { matchesAny, type ErrorReportContext, type ExceptionHandler } from './exception-handler';

/**
 * The resolved reporting facade every transport edge (HTTP, WS, live, queue,
 * schedule) uses. `report` is fire-and-forget and fully contained — a broken
 * or throwing handler can never mask the original error. `render` gives a
 * handler the chance to override the client-bound response.
 */
export interface ErrorReporter {
  catalog: Catalog<string>;
  report(error: unknown, ctx: ErrorReportContext): void;
  render(error: unknown, executionCtx: unknown): Response | ErrorBodyResult | undefined;
}

/**
 * Build an {@link ErrorReporter} from a container. Reads the optional
 * {@link APP_EXCEPTION_HANDLER} and {@link ERROR_CATALOG} providers; with
 * neither registered the reporter logs (unless diagnostics is `'silent'`) and
 * exposes the core catalog.
 */
export const resolveErrorReporter = (container: Container): ErrorReporter => {
  const handler: ExceptionHandler | undefined = container.has(APP_EXCEPTION_HANDLER)
    ? container.resolve(APP_EXCEPTION_HANDLER)
    : undefined;
  const catalog: Catalog<string> = container.has(ERROR_CATALOG)
    ? container.resolve(ERROR_CATALOG)
    : CORE_CATALOG;

  return {
    catalog,
    report(error, ctx) {
      let suppressed = false;
      try {
        suppressed = matchesAny(handler?.dontReport, error);
      } catch {
        // A broken matcher must never mask the original error — treat as no match.
      }
      if (suppressed) return;
      const merged = handler?.context ? { ...ctx, ...safeContext(handler, error, ctx) } : ctx;
      if (handler?.report) {
        try {
          void Promise.resolve(handler.report(error, merged)).catch(() => {});
        } catch {
          // A broken reporter must never mask the original error.
        }
        return;
      }
      if (container.getDiagnostics() !== 'silent') {
        const status = clientFaultStatus(error);
        if (status !== undefined && status >= 400 && status < 500) return; // client fault — not server-error log noise
        console.error(
          `[vela] ${merged.edge} error${merged.source ? ` in ${merged.source}` : ''}${merged.note ? ` (${merged.note})` : ''}:`,
          error,
        );
      }
    },
    render(error, executionCtx) {
      try {
        return handler?.render?.(error, executionCtx);
      } catch {
        return undefined; // broken render hook falls through to default render
      }
    },
  };
};

/**
 * The HTTP status of a client-fault (4xx) error, read across the three shapes a
 * caught error can take: a branded {@link VelaError} (`.status`), vela's own
 * {@link HttpException} (`getStatus()`), or hono's {@link HTTPException}
 * (`.status`). `undefined` for anything else — including raw/unbranded errors,
 * which must always be logged. Only the DEFAULT console reporter uses this to
 * mute client faults; a custom `handler.report` still receives everything.
 */
const clientFaultStatus = (error: unknown): number | undefined => {
  if (isVelaError(error)) return error.status;
  if (error instanceof HttpException) return error.getStatus();
  if (error instanceof HTTPException) return error.status; // hono
  return undefined;
};

const safeContext = (
  handler: ExceptionHandler,
  error: unknown,
  ctx: ErrorReportContext,
): Record<string, unknown> => {
  try {
    return handler.context?.(error, ctx) ?? {};
  } catch {
    return {};
  }
};
