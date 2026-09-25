import type { DynamicModule, Type } from '@velajs/vela';

/**
 * The root a Worker or Durable Object is built from: a module class or a
 * `DynamicModule`, declared once at module scope. Configuration that needs
 * bindings belongs in providers and `forRootAsync({ inject: [ENV] })`
 * factories, which run for each application with that application's ENV.
 */
export type CloudflareRoot = Type | DynamicModule;

/**
 * @internal `root` with `providers` added to the root module's own providers,
 * so each one injects what the root module can see.
 */
export function withRootProviders(root: CloudflareRoot, providers: readonly Type[]): DynamicModule {
  if (typeof root === 'function') return { module: root, providers: [...providers] };
  return { ...root, providers: [...(root.providers ?? []), ...providers] };
}
