import { createParamDecorator } from '@velajs/vela';

/**
 * Parameter decorator to inject Cloudflare environment bindings.
 *
 * Without arguments, returns the entire `env` object.
 * With a binding name, returns that specific binding.
 *
 * @example
 * ```ts
 * @Get()
 * handle(@Env() env: CloudflareEnv) { ... }
 *
 * @Get()
 * handle(@Env('MY_KV') kv: KVNamespace) { ... }
 * ```
 */
export const Env = createParamDecorator<string | undefined>(
  (bindingName, ctx) => {
    // Hono Context has .env on Cloudflare Workers
    const c = ctx.getContext<{ env?: Record<string, unknown> }>();
    const env = c.env;
    if (!env) return undefined;
    return bindingName ? env[bindingName] : env;
  },
);
