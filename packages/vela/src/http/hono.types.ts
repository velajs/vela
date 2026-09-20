import type { Context, Hono, MiddlewareHandler } from 'hono';

/**
 * Core does not know an application's platform bindings or middleware values.
 * Resolve the platform's typed environment token and use RequestContextKey for
 * typed request values. Raw Hono variables remain unknown until narrowed.
 */
export interface VelaHonoEnv {
  Bindings: object;
  Variables: Record<string, unknown>;
}

export type VelaContext = Context<VelaHonoEnv>;
export type VelaHono = Hono<VelaHonoEnv>;
export type VelaMiddlewareHandler = MiddlewareHandler<VelaHonoEnv>;
