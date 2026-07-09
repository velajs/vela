import type { OpenApiPathItem, Type } from '@velajs/vela';
import { MetadataRegistry } from '@velajs/vela/internal';
// hono-crud owns the authoritative per-endpoint OpenAPI schema. `defineEndpoints`
// + `toOpenApiPaths` are both pure and synchronous (no server, no node:*
// imports, no `Model.resolveSchema()`) so they are safe to import statically
// here even though the runtime route path in `builder.ts` keeps its lazy
// `loadHonoCrud()` dynamic import. Edge-safety is enforced by
// `src/__tests__/edge-runtime-audit.test.ts`.
import { defineEndpoints, toOpenApiPaths } from 'hono-crud';
import { buildCrudEndpointsDef } from './builder';
import type { CrudConfig } from './types';

interface OpenApiContext {
  globalPrefix: string;
  controllerPrefix: string;
}

// vela's `@ApiTags(...)` decorator stores the tag array under this metadata
// key (see `@velajs/vela`'s openapi/decorators.ts: `API_TAGS_METADATA`). It is
// not re-exported from the public surface, so we read it the same way vela's
// own `getApiTags` does — through the exported `MetadataRegistry`.
const API_TAGS_METADATA = 'vela:openapi:tags';

/**
 * Synchronously contribute OpenAPI path items for a `@Crud()`-decorated
 * controller. Registered on the vela bridge as `buildOpenApiPaths`; vela's
 * `createOpenApiDocument` calls it synchronously while assembling the
 * document, so this MUST NOT be async.
 *
 * The paths are produced by hono-crud's `toOpenApiPaths` — the single source
 * of truth for the CRUD spec. We feed it the *same* endpoints definition the
 * route builder mounts at request time (via the shared
 * {@link buildCrudEndpointsDef} helper), so the documented surface always
 * matches the live routes and covers *every* generated verb (list/read/
 * create/update/delete plus search/aggregate/upsert/restore/clone/export/
 * import and all `batch*` verbs) with hono-crud's own request/response
 * schemas — not a lossy hand-rolled 5-verb subset.
 *
 * Path keys are fully qualified (`{globalPrefix}{controllerPrefix}`); vela
 * merges them verb-by-verb into the document, preserving any hand-written
 * `@Get`/`@Post` on the same controller.
 */
export function buildCrudOpenApiPaths(
  controller: Type,
  crudConfig: CrudConfig,
  ctx: OpenApiContext,
): Record<string, OpenApiPathItem> {
  const basePath = joinOpenApiPaths(ctx.globalPrefix, ctx.controllerPrefix);

  // `@ApiTags(...)` on the controller is the explicit framework-level
  // override and must win over hono-crud's per-endpoint tag resolution
  // (`openapi.tags` > `model.tag` > `model.tableName`). When absent we pass
  // `undefined` so hono-crud applies its own fallback chain.
  const tag = resolveApiTagsOverride(controller);

  const endpointsDef = buildCrudEndpointsDef(crudConfig);
  const endpoints = defineEndpoints(endpointsDef, crudConfig.adapters);

  return toOpenApiPaths(endpoints, { basePath, tag }) as Record<
    string,
    OpenApiPathItem
  >;
}

function resolveApiTagsOverride(controller: Type): string | undefined {
  const declared = MetadataRegistry.getCustomClassMeta(controller, API_TAGS_METADATA);
  if (!Array.isArray(declared)) return undefined;
  const first = declared.find((t): t is string => typeof t === 'string' && t.length > 0);
  return first;
}

// Mirrors `@velajs/vela`'s `joinPaths` + `toOpenApiPath`: collapse the
// boundary slash between prefix and path, guarantee a single leading slash,
// and normalize to an OpenAPI-style path. We only ever join two known,
// already-simple segments here so a focused normalize is sufficient.
// hono-crud's `toOpenApiPaths` slash-normalizes `basePath` again on its side,
// but normalizing here keeps the contract explicit and the join `:param` ->
// `{param}` conversion is needed before hono-crud appends its own path keys.
function joinOpenApiPaths(globalPrefix: string, controllerPrefix: string): string {
  const clean = (s: string): string => (s ? s.replace(/\/+$/, '') : '');
  const lead = (s: string): string => (s && !s.startsWith('/') ? `/${s}` : s);
  const joined = `${clean(lead(globalPrefix))}${clean(lead(controllerPrefix))}`;
  const normalized = (joined || '/').replace(/\/{2,}/g, '/');
  return normalized.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');
}
