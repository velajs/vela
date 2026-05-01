import { VelaFactory } from '@velajs/vela';
import type { Type } from '@velajs/vela';
import { Container } from '@velajs/vela/internal';
import { BindingRef } from './binding-ref';
import { CloudflareApplication } from './cloudflare-application';

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
 * Create a Cloudflare Workers application.
 *
 * Sets up a one-time Hono middleware that captures `c.env` on the first
 * request and initializes all configured binding refs.
 *
 * @example
 * ```ts
 * const app = await createCloudflareApp(AppModule);
 * export default app; // has .fetch, .scheduled, .queue
 * ```
 */
export async function createCloudflareApp(rootModule: Type): Promise<CloudflareApplication> {
  let initialized = false;
  let refs: BindingRef[] | undefined;

  const velaApp = await VelaFactory.create(rootModule, {
    middleware: [
      async (c, next) => {
        if (!initialized) {
          initialized = true;
          const env = (c.env as Record<string, unknown>) ?? {};
          for (const ref of refs!) {
            ref._initialize(env[ref.bindingName]);
          }
        }
        await next();
      },
    ],
  });

  refs = collectBindingRefs(velaApp.getContainer());

  const cfApp = new CloudflareApplication(velaApp);
  cfApp.scanInstances(velaApp.getInstances());
  return cfApp;
}
