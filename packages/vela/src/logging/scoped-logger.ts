import type { Container } from '../container/container';
import { assertExecutionScopeActive, getExecutionLifetime } from '../entrypoint/execution-scope';
import { REQUEST_CONTEXT } from '../http/request-context';
import type { StructuredLogger } from './application-logger';
import type { LogDeliveryContext, LogFields } from './log.types';
import { APP_LOGGER } from './logging.module';

/** @internal Explicit metadata/completion read path shared with exception reporting. */
export function logDeliveryForScope(container: Container): LogDeliveryContext {
  const lifetime = getExecutionLifetime(container);
  const fields: Record<string, unknown> = {};
  if (lifetime) fields.invocationId = lifetime.id;
  try {
    if (container.has(REQUEST_CONTEXT)) fields.requestId = container.resolve(REQUEST_CONTEXT).id;
  } catch {
    // Non-HTTP/application scopes intentionally have no REQUEST_CONTEXT instance.
  }
  return {
    fields,
    ...(lifetime
      ? {
          isActive: () => lifetime.active,
          waitUntil: (promise: Promise<void>) => lifetime.waitUntil(promise),
        }
      : {}),
  };
}

/**
 * Requires APP_LOGGER. Use the actual invocation child (e.g. context.getContainer()).
 * Correlation is immutable, overrides caller fields, and carries no authority.
 */
export function loggerForScope(
  container: Container,
  category = 'app',
  fields: LogFields = {},
): StructuredLogger {
  assertExecutionScopeActive(container);
  return container
    .resolve(APP_LOGGER)
    .createLogger(category, fields, logDeliveryForScope(container));
}
