import type { DynamicModule, Type } from '@velajs/vela';

/**
 * The root a Worker or Durable Object is built from: a module class or a
 * `DynamicModule`, declared once at module scope. Configuration that needs
 * bindings belongs in providers and `forRootAsync({ inject: [ENV] })`
 * factories, which run for each application with that application's ENV.
 */
export type CloudflareRoot = Type | DynamicModule;
