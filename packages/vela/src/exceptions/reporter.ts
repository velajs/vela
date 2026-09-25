import { CORE_CATALOG, isVelaError, type Catalog, type ErrorBodyResult } from '@velajs/errors';
import { HTTPException } from 'hono/http-exception';
import { Scope } from '../constants';
import type { Container } from '../container/container';
import { isOwnedHttpError } from '../errors/http-exception';
import { APP_EXCEPTION_HANDLER, ERROR_CATALOG } from '../pipeline/tokens';
import { APP_LOGGER } from '../logging/logging.tokens';
import { logDeliveryForScope } from '../logging/scoped-logger';
import { matchesAny, type ErrorReportContext, type ExceptionHandler } from './exception-handler';
import { isClientErrorStatus } from './render-http-error';

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
  const handler = resolveHandler(container);
  const catalog: Catalog<string> = container.has(ERROR_CATALOG)
    ? container.resolve(ERROR_CATALOG)
    : CORE_CATALOG;

  // Capture before disposal so completion failures can still carry inert correlation.
  // The reporter must not resolve request-owned services from an already closed child.
  const delivery = logDeliveryForScope(container);
  const diagnostics = container.getDiagnostics();
  const structured = container.has(APP_LOGGER);
  const logging = structured ? container.resolve(APP_LOGGER) : undefined;
  const logger = logging?.createLogger(
    'exception',
    {},
    {
      fields: delivery.fields,
      waitUntil: delivery.waitUntil,
    },
  );

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
      const merged = { ...ctx, ...safeContext(handler, error, ctx), ...delivery.fields };
      if (handler?.report) {
        try {
          // oxlint-disable-next-line promise/no-promise-in-callback -- Reporting hooks support async completion.
          const completion = Promise.resolve(handler.report(error, merged)).catch(() => {});
          // Reporting failures remain contained; invocation resources stay alive until settled.
          delivery.waitUntil?.(completion);
        } catch {
          // A broken reporter must never mask the original error.
        }
        return;
      }
      if (diagnostics !== 'silent') {
        const status = clientFaultStatus(error);
        // A client fault is not server-error log noise; a status the edge
        // cannot answer (404.5, NaN) renders as a 500 and is logged.
        if (status !== undefined && isClientErrorStatus(status)) return;
        if (structured) {
          try {
            logger?.withFields(merged).error(error);
          } catch {
            // Never fall back to the raw error if structured logging is configured.
          }
          return;
        }
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
 * A request-scoped handler exists only inside an invocation. Application-level
 * edges report on the root container, where it cannot be built; they fall back
 * to the default report instead of masking the error being reported.
 */
const resolveHandler = (container: Container): ExceptionHandler | undefined => {
  if (!container.has(APP_EXCEPTION_HANDLER)) return undefined;
  if (container.getResolvedScope(APP_EXCEPTION_HANDLER) !== Scope.REQUEST) {
    return container.resolve(APP_EXCEPTION_HANDLER);
  }
  try {
    return container.resolve(APP_EXCEPTION_HANDLER);
  } catch {
    return undefined;
  }
};

/**
 * The HTTP status of a client-fault (4xx) error, read across the three shapes a
 * caught error can take: a branded {@link VelaError} (`.status`), vela's own
 * `HttpException` (`getStatus()`), or hono's {@link HTTPException}
 * (`.status`). `undefined` for anything else — including raw/unbranded errors,
 * which must always be logged. Only the DEFAULT console reporter uses this to
 * mute client faults; a custom `handler.report` still receives everything.
 */
const clientFaultStatus = (error: unknown): number | undefined => {
  try {
    if (isVelaError(error)) return error.status;
    if (isOwnedHttpError(error)) return error.getStatus();
    if (error instanceof HTTPException) return error.status;
  } catch {
    // An uninspectable error remains reportable rather than hiding the failure.
  }
  return undefined;
};

const safeContext = (
  handler: ExceptionHandler | undefined,
  error: unknown,
  ctx: ErrorReportContext,
): Record<string, unknown> => {
  try {
    return { ...handler?.context?.(error, ctx) };
  } catch {
    return {};
  }
};
