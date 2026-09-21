import type { Context, MiddlewareHandler } from 'hono';
import { contextStorage, getContext } from 'hono/context-storage';
import type { Container } from '../container/container';
import { assertExecutionScopeActive } from '../entrypoint/execution-scope';
import { REQUEST_CONTEXT, type RequestContext } from './request-context';
import { findRequestContainer } from './request-container';

// Opt-in ambient access to the per-request DI container / RequestContext,
// for deep code that lacks the Hono `Context` (services, standalone helpers).
//
// Portable across vela's target runtimes because the `node:async_hooks`
// dependency lives inside Hono's `contextStorage()` middleware — vela's own
// source never imports `node:*`. Uses only the workerd-safe ALS subset
// (`run()`/`getStore()`); no `enterWith`, no cross-thenable propagation.
//
// Default path is unchanged: request scope is still carried by the per-request
// child container (see RouteManager.getRequestContainer). This is a second
// READ path, active only when enabled.

/**
 * Returns Hono's `contextStorage()` middleware. Register it as the FIRST global
 * middleware so `getCurrentContainer()` works everywhere downstream. When using
 * `VelaFactory.create(module, { ambientContainer: true })` this is wired
 * automatically — call this only for manual/raw Hono setups.
 */
export function enableAmbientContainer(): MiddlewareHandler {
  return contextStorage();
}

function tryGetContext(): Context | undefined {
  try {
    return getContext();
  } catch {
    // Thrown when called outside the contextStorage() middleware (i.e. ambient
    // access not enabled, or outside a request).
    return undefined;
  }
}

/**
 * The current request's DI container. Throws with actionable guidance if
 * ambient access isn't enabled or this runs outside a request.
 */
export function getCurrentContainer(): Container {
  const context = tryGetContext();
  const container = context ? findRequestContainer(context) : undefined;
  if (!container) {
    throw new Error(
      'getCurrentContainer() is unavailable: enable ambient access via ' +
        'VelaFactory.create(module, { ambientContainer: true }) (or app.use(enableAmbientContainer())) ' +
        'and only call it within a request.',
    );
  }
  assertExecutionScopeActive(container);
  return container;
}

/** The current request's {@link RequestContext} (via the ambient container). */
export function getCurrentRequestContext(): RequestContext {
  return getCurrentContainer().resolve(REQUEST_CONTEXT);
}
