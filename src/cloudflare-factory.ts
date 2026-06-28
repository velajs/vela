import type { MiddlewareHandler } from 'hono';
import { VelaFactory } from '@velajs/vela';
import type { Type } from '@velajs/vela';
import { Container } from '@velajs/vela/internal';
import { BindingRef } from './binding-ref';
import { CloudflareApplication } from './cloudflare-application';
import { EnvRef } from './env-ref';

// Walks every provider registered in the container and pulls out the
// BindingRef instances. Replaces the old module-level `bindingsRegistry`
// global so two CloudflareApplication instances in one process don't
// share state.
function collectBindingRefs(container: Container): BindingRef[] {
  const refs: BindingRef[] = [];
  for (const token of container.getTokens()) {
    let value: unknown;
    try {
      value = container.resolve(token);
    } catch {
      continue;
    }
    if (value instanceof BindingRef) refs.push(value);
  }
  return refs;
}

/**
 * Options for {@link createCloudflareApp}.
 *
 * Mirrors a tight subset of vela's `BootstrapOptions` — only the surface
 * that makes sense for a Workers consumer is re-exposed.
 */
export interface CreateCloudflareAppOptions {
  /**
   * Forwarded to `VelaFactory.create({ globalPrefix })`. Prepended to every
   * route registered by `@Controller(...)` (and any other route emitter)
   * inside the application, so a value of `'/v1'` turns `@Controller('/users')`
   * into `/v1/users`.
   *
   * @example
   * ```ts
   * const app = await createCloudflareApp(AppModule, { globalPrefix: '/v1' });
   * ```
   */
  globalPrefix?: string;

  /**
   * Extra Hono middleware to register on the underlying Hono app. Runs
   * AFTER the one-time binding-init middleware this adapter mounts
   * internally, so any handler in `middleware` can safely read from
   * `BindingRef` instances and Cloudflare env bindings.
   *
   * @example
   * ```ts
   * const app = await createCloudflareApp(AppModule, {
   *   middleware: [
   *     async (c, next) => {
   *       c.set('requestId', crypto.randomUUID());
   *       await next();
   *     },
   *   ],
   * });
   * ```
   */
  middleware?: MiddlewareHandler[];
}

/**
 * Create a Cloudflare Workers application.
 *
 * Sets up a one-time Hono middleware that captures `c.env` on the first
 * request and initializes all configured binding refs. Optional
 * {@link CreateCloudflareAppOptions} are forwarded to the underlying
 * `VelaFactory.create` so consumers don't have to wrap the resulting
 * application in an outer Hono just to set a `globalPrefix` or attach
 * extra request middleware.
 *
 * @example
 * ```ts
 * // Minimal — backwards compatible
 * const app = await createCloudflareApp(AppModule);
 * export default app; // has .fetch, .scheduled, .queue
 * ```
 *
 * @example
 * ```ts
 * // With a global prefix and outer middleware
 * const app = await createCloudflareApp(AppModule, {
 *   globalPrefix: '/v1',
 *   middleware: [
 *     async (c, next) => {
 *       c.set('tenantId', c.req.header('x-tenant-id') ?? 'public');
 *       await next();
 *     },
 *   ],
 * });
 * ```
 */
export async function createCloudflareApp(
  rootModule: Type,
  options: CreateCloudflareAppOptions = {},
): Promise<CloudflareApplication> {
  let initialized = false;
  let refs: BindingRef[] | undefined;

  const bindingInit: MiddlewareHandler = async (c, next) => {
    if (!initialized) {
      initialized = true;
      const env = (c.env as Record<string, unknown>) ?? {};
      for (const ref of refs!) {
        // EnvRef holds the whole env; every other ref holds one binding.
        if (ref instanceof EnvRef) ref._initialize(env);
        else ref._initialize(env[ref.bindingName]);
      }
    }
    await next();
  };

  // IMPORTANT: keep the binding-init middleware FIRST so user middleware
  // can safely read binding refs / `c.env` derivatives on the first request.
  const velaApp = await VelaFactory.create(rootModule, {
    globalPrefix: options.globalPrefix,
    middleware: [bindingInit, ...(options.middleware ?? [])],
  });

  refs = collectBindingRefs(velaApp.getContainer());

  const cfApp = new CloudflareApplication(velaApp);
  cfApp.scanInstances(velaApp.getInstances());
  return cfApp;
}
