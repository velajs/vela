import { isRecord } from './connection';

/**
 * Application-introspection wire contract (the `app.*` and `api.authorizeTryIt` ops).
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

function stringMap(input: unknown): Record<string, string> | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) throw new Error('Expected string-valued headers or query parameters.');
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(input)) {
    if (typeof item !== 'string')
      throw new Error('Expected string-valued headers or query parameters.');
    result[key] = item;
  }
  return result;
}

/** Validate JSON from the local API explorer before any request can be sent. */
export function parseTryItRequest(value: unknown): TryItRequest {
  if (
    !isRecord(value) ||
    typeof value.method !== 'string' ||
    !/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/i.test(value.method) ||
    typeof value.path !== 'string' ||
    !value.path.startsWith('/') ||
    value.path.startsWith('//') ||
    /[\\\\#\s{}]/.test(value.path)
  ) {
    throw new Error('Expected an HTTP method and a resolved absolute path on the Worker.');
  }
  return {
    method: value.method.toUpperCase(),
    path: value.path,
    query: stringMap(value.query),
    headers: stringMap(value.headers),
    body: value.body,
  };
}

export function parseTryItResponse(value: unknown): TryItResponse {
  if (
    !isRecord(value) ||
    typeof value.status !== 'number' ||
    !Number.isInteger(value.status) ||
    value.status < 100 ||
    value.status > 599 ||
    !isRecord(value.headers) ||
    !('body' in value)
  )
    throw new Error('Invalid API response.');
  const headers: Record<string, string> = {};
  for (const [key, item] of Object.entries(value.headers)) {
    if (typeof item !== 'string') throw new Error('Invalid API response headers.');
    headers[key] = item;
  }
  return { status: value.status, headers, body: value.body };
}
