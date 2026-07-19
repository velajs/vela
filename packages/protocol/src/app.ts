/**
 * Application-introspection wire contract (the `app.*` and `api.tryit` ops).
 *
 * `RouteRow` mirrors `@velajs/cli` `introspect.ts` `RouteRow`, and `ModuleNode`
 * mirrors vela's `ModuleDescription` (`vela/src/container/types.ts`) field-for-
 * field. `EntrypointRow` intentionally carries `meta?: unknown` (the wire shape)
 * rather than the CLI's serialized `meta: string`. See the report for sources.
 */

/** One row of the app route table. Mirrors `@velajs/cli` `RouteRow`. */
export interface RouteRow {
  method: string;
  path: string;
  /** `Controller#handler`, or `(mounted)` for routes vela did not compose itself. */
  handler: string;
  source: 'controller' | 'mounted';
}

/**
 * One module instance in the loaded graph. Structural mirror of vela's
 * `ModuleDescription` (`Container.getModuleDescriptions()`).
 */
export interface ModuleNode {
  moduleId: string;
  /** moduleIds this instance imports. */
  imports: string[];
  isGlobal: boolean;
  lazy: boolean;
  /** Token labels registered in this instance's bucket (registration order). */
  providers: string[];
  /** Token labels this instance exports. */
  exports: string[];
}

/** One entrypoint entry (queue/cron/etc.). Wire shape: `meta` is optional/unknown. */
export interface EntrypointRow {
  kind: string;
  target: string;
  meta?: unknown;
}

/** An API "try it" request proxied against the app. */
export interface TryItRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}

/** The response captured from a "try it" request. */
export interface TryItResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}
