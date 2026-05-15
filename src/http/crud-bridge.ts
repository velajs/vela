import type { Hono } from 'hono';
import type { Type } from '../container/types';
import type { CanActivate } from '../pipeline/types';
import type { OpenApiPathItem } from '../openapi/types';

/**
 * Context passed to {@link CrudBridge.buildRoutes} when mounting CRUD
 * sub-applications for a `@Crud()`-decorated controller.
 *
 * The bridge receives the framework's already-resolved view of the world so
 * it can produce identical routing behavior to a hand-written controller:
 * the same global prefix is prepended to every path, the same global guard
 * instances run before any generated handler, and the same path-joining
 * helper composes URL segments without double slashes.
 */
export interface CrudBridgeRouteContext {
  /** Application-wide path prefix (e.g. `/api`), already normalized. */
  globalPrefix: string;
  /** Global guard instances, pre-resolved from the root container. */
  globalGuards: CanActivate[];
  /** Path joiner used by the framework — handles slash normalization. */
  joinPaths: (...parts: string[]) => string;
}

/**
 * Context passed to {@link CrudBridge.buildOpenApiPaths} when contributing
 * OpenAPI path items for a `@Crud()`-decorated controller.
 *
 * The bridge is responsible for producing fully-qualified path keys that
 * match the routes it actually mounts at request time. The framework supplies
 * the prefixes so the bridge does not have to re-derive them.
 */
export interface CrudBridgeOpenApiContext {
  /** Application-wide path prefix (e.g. `/api`), already normalized. */
  globalPrefix: string;
  /** Controller-level prefix as registered with `@Controller(...)`. */
  controllerPrefix: string;
}

/**
 * Contract between `@velajs/vela` and a CRUD route generator (typically
 * `@velajs/crud`). The bridge inverts the previous dynamic-import pattern,
 * which was incompatible with Cloudflare Workers because esbuild leaves
 * `await import(variable)` calls as runtime imports the Workers loader
 * cannot resolve.
 *
 * A consumer registers an implementation once via {@link registerCrudBridge}
 * — usually as a side effect of importing `@velajs/crud` — and the framework
 * delegates both route building (at bootstrap) and OpenAPI generation
 * (at document creation) to it.
 */
export interface CrudBridge {
  /**
   * Mount the CRUD sub-app for a controller with `vela:crud` metadata.
   *
   * Called during {@link RouteManager.build} after all `@Get`/`@Post`/etc.
   * routes have been registered. The bridge is expected to attach generated
   * routes (list, read, create, update, delete, …) onto the supplied Hono
   * app under `ctx.globalPrefix + prefix`.
   */
  buildRoutes(
    app: Hono,
    controller: Type,
    prefix: string,
    crudConfig: unknown,
    ctx: CrudBridgeRouteContext,
  ): Promise<void>;

  /**
   * Contribute OpenAPI path items for a `@Crud()`-decorated controller.
   *
   * Called once per CRUD controller from `createOpenApiDocument` after the
   * standard `@Get`/`@Post`/etc. paths have been collected. The returned
   * record maps full OpenAPI path strings (e.g. `/api/users/{id}`) to path
   * items, and is merged into the document — entries already present from
   * hand-written handlers are preserved verb-by-verb.
   */
  buildOpenApiPaths(
    controller: Type,
    crudConfig: unknown,
    ctx: CrudBridgeOpenApiContext,
  ): Record<string, OpenApiPathItem>;
}

let registered: CrudBridge | undefined;

/**
 * Register a {@link CrudBridge} implementation. Intended to be called once at
 * import time by the CRUD package; subsequent calls overwrite the previous
 * registration (last-writer-wins). This is deliberate so test harnesses can
 * swap in mocks without a teardown step on the global state.
 */
export function registerCrudBridge(bridge: CrudBridge): void {
  registered = bridge;
}

/**
 * Return the currently registered {@link CrudBridge}, or `undefined` if no
 * bridge has been registered. Consumers using `@Crud()` without a registered
 * bridge will receive a clear install-it error from the framework at build
 * time — see `RouteManager.build`.
 */
export function getCrudBridge(): CrudBridge | undefined {
  return registered;
}

/**
 * Reset the global bridge registration. Test-only — not exported from
 * `@velajs/vela/internal`. Use this in `beforeEach` to keep cases isolated.
 *
 * @internal
 */
export function _resetCrudBridge(): void {
  registered = undefined;
}
