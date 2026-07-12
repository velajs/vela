import { CORE_CATALOG, type Catalog, type ErrorBodyResult } from '@velajs/errors';
import type { Container } from '../container/container';
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
  const catalog: Catalog<string> = container.has(ERROR_CATALOG) ? container.resolve(ERROR_CATALOG) : CORE_CATALOG;

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
