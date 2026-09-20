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
 * handle(@Env() env: WorkerEnv) { ... }
 *
 * @Get()
 * handle(@Env('MY_KV') kv: KVNamespace) { ... }
 * ```
 */
export const Env = createParamDecorator<string | undefined>((bindingName, ctx): unknown => {
  // Hono Context has .env on Cloudflare Workers
  const env: unknown = ctx.getContext().env;
  if (typeof env !== 'object' || env === null) return undefined;
  return bindingName ? Reflect.get(env, bindingName) : env;
});
