import type { Context, Hono, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { CanActivate, Container, ExecutionContext, HttpArgumentsHost, NestMiddleware, Type } from '@velajs/vela';
import { ForbiddenException, HttpException } from '@velajs/vela';
import { ComponentManager } from '@velajs/vela/internal';
import type { EndpointMiddlewares, MetaInput, RegisterCrudOptions } from 'hono-crud';
import type { AdapterBundle, EndpointsConfig, GeneratedEndpoints } from 'hono-crud/config';
import { getOverrides } from './override.decorator';
import {
  adapterProvidesEndpoint,
  ALL_CRUD_ENDPOINTS,
  assertTenantResolverMounted,
  crudEndpointSlot,
  type CrudConfig,
  type CrudEndpointName,
  VERSION_ENDPOINTS,
} from './types';

interface BuilderContext {
  globalPrefix: string;
  globalGuards: CanActivate[];
  joinPaths: (...parts: string[]) => string;
  // Root container from vela's RouteContributor path — required to resolve
  // controller-scoped `@UseGuards`/`@UseMiddleware` instances now that
  // `ComponentManager.resolve*` is stateless (no process-global container).
  // Optional so `buildCrudRoutes` stays directly callable in unit tests that
  // register neither guards nor middleware (the resolvers are never reached).
  container?: Container;
}

interface HonoCrudModule {
  fromHono: (app: Hono) => Hono;
  registerCrud: (
    app: Hono,
    basePath: string,
    endpoints: GeneratedEndpoints,
    options?: RegisterCrudOptions,
  ) => void;
  defineEndpoints: <M extends MetaInput>(
    config: EndpointsConfig<M>,
    adapters: AdapterBundle,
  ) => GeneratedEndpoints;
  // From hono-crud/internal: record a resource on a given app's registry so
  // addons (e.g. @hono-crud/mcp auto) can enumerate it via
  // getRegisteredCrudResources(app). registerCrud only records on the sub-app.
  // Optional: absent on hono-crud versions that predate this export — the
  // bridge degrades gracefully (no MCP auto-discovery) rather than crashing.
  recordCrudResource?: (app: Hono, path: string, endpoints: GeneratedEndpoints) => void;
}

interface HonoZodOpenapiModule {
  OpenAPIHono: new () => Hono;
}

export async function buildCrudRoutes(
  app: Hono,
  controller: Type,
  prefix: string,
  crudConfig: CrudConfig,
  ctx: BuilderContext,
): Promise<void> {
  // Tenant-scoped Models without an upstream resolver silently propagate
  // `tenantId: undefined` through HookContext and CrudEventPayload — a
  // data-loss bug class. Fail fast here so the misconfiguration cannot
  // ship. See {@link MissingTenantResolverError} for the recovery shape.
  assertTenantResolverMounted({
    meta: crudConfig.meta,
    mountPath: ctx.joinPaths(ctx.globalPrefix, prefix) || '/',
    tenantResolverMounted: crudConfig.tenantResolverMounted,
  });

  const { fromHono, registerCrud, defineEndpoints, recordCrudResource } = await loadHonoCrud();
  const { OpenAPIHono } = await loadHonoZodOpenapi();

  // Validation + only/except resolution + per-endpoint/dto/hooks merge is the
  // single source of truth for what hono-crud generates. The OpenAPI bridge
  // (`buildCrudOpenApiPaths`) reuses this exact helper so the documented
  // surface can never drift from the mounted routes.
  const endpointsDef = buildCrudEndpointsDef(crudConfig);
  const endpoints = defineEndpoints(endpointsDef, crudConfig.adapters);

  const middlewares = buildGuardMiddleware(controller, ctx.globalGuards, ctx.container);
  const endpointMiddlewares = buildOverrideMiddlewares(controller);
  const controllerMiddleware = buildControllerMiddleware(controller, ctx.container);

  const openApiHono = new OpenAPIHono();

  // Controller-level `@UseMiddleware(...)` must run on generated CRUD routes
  // exactly as it does on hand-written `@Get`/`@Post` handlers. vela's
  // RouteManager attaches these per route; the CRUD sub-app is opaque to it,
  // so previously this middleware was silently dropped — a per-request
  // DB-binding middleware never ran and every CRUD call 500'd. Register here
  // on the OpenAPIHono *before* `fromHono`/`registerCrud` so it runs ahead of
  // the guard middleware and every generated handler (controller → guards →
  // handler), mirroring RouteManager's ordering for normal routes.
  for (const mw of controllerMiddleware) {
    openApiHono.use('*', mw);
  }
  openApiHono.onError((err, c) => {
    if (err instanceof HttpException) {
      return c.json(err.getResponse(), err.getStatus() as ContentfulStatusCode);
    }
    // Rethrow non-HttpException errors so the parent app's `onError` (or any
    // framework filter chain registered above the sub-app) can render them.
    // Prior versions emitted a generic 500 here, which silently swallowed
    // custom error subclasses thrown by middleware/hooks and prevented the
    // parent's APP_FILTER coverage from reaching this resource.
    throw err;
  });

  const subApp = fromHono(openApiHono);
  registerCrud(subApp, '', endpoints, {
    middlewares: middlewares.length > 0 ? middlewares : undefined,
    endpointMiddlewares: Object.keys(endpointMiddlewares).length > 0 ? endpointMiddlewares : undefined,
    // Forward verbatim — see CrudConfig.responseEnvelope. Omitted when
    // unset so hono-crud falls back to its default envelope.
    responseEnvelope: crudConfig.responseEnvelope,
  });

  const mountPath = ctx.joinPaths(ctx.globalPrefix, prefix) || '/';
  app.route(mountPath, subApp);

  // registerCrud recorded this resource on the isolated sub-app (path ''); also
  // record it on the MAIN app with its real mount path so addons that enumerate
  // via getRegisteredCrudResources(mainApp) — notably @hono-crud/mcp's `auto`
  // discovery — can find it (and re-dispatch tool calls through the mounted
  // routes). Without this, MCP auto-discovers zero resources. Guarded: older
  // hono-crud doesn't export recordCrudResource (then MCP discovery is simply
  // unavailable instead of throwing).
  recordCrudResource?.(app, mountPath, endpoints);
}

/**
 * Build the hono-crud `EndpointsConfig` from a `CrudConfig` — the single
 * source of truth for *which* CRUD verbs exist and *how* they are shaped
 * (only/except filtering, per-endpoint config, flat `dto`/`hooks` sugar).
 *
 * Both the route builder (`buildCrudRoutes`, runtime mount) and the OpenAPI
 * bridge (`buildCrudOpenApiPaths`, document generation) call this so the
 * emitted spec can never drift from the mounted routes. It is pure and
 * synchronous; callers pass the result to hono-crud's `defineEndpoints`.
 */
export function buildCrudEndpointsDef(config: CrudConfig): EndpointsConfig<MetaInput> {
  validateEndpointNames(config);
  return buildEndpointsDef(config, resolveEnabledEndpoints(config));
}

function validateEndpointNames(config: CrudConfig): void {
  const valid = new Set<string>(ALL_CRUD_ENDPOINTS);
  const list = (xs: readonly string[]) => xs.join(' | ');

  for (const source of ['only', 'except'] as const) {
    const arr = config[source];
    if (!arr) continue;
    for (const name of arr) {
      if (!valid.has(name)) {
        throw new Error(
          `@Crud: unknown endpoint name '${name}' in '${source}'. Valid: ${list(ALL_CRUD_ENDPOINTS)}.`,
        );
      }
    }
  }

  if (config.endpoints) {
    for (const name of Object.keys(config.endpoints)) {
      if (!valid.has(name)) {
        throw new Error(
          `@Crud: unknown endpoint name '${name}' in 'endpoints'. Valid: ${list(ALL_CRUD_ENDPOINTS)}.`,
        );
      }
    }
  }
}

function resolveEnabledEndpoints(config: CrudConfig): CrudEndpointName[] {
  // Explicit `only` is an explicit request: do NOT silently drop unsupported
  // verbs here. They are loud-failed in buildEndpointsDef with a clear @Crud:
  // error instead of a silent skip.
  if (config.only) return [...config.only];

  // For the default-derived lists (no selection, or `except`), restore the
  // pre-0.13 "just works" DX: enable only the verbs the adapter bundle ships.
  // hono-crud 0.13 throws at definition time when a configured verb's adapter
  // slot is absent, so a partial custom AdapterBundle must not auto-enable a
  // verb the consumer never explicitly asked for. First-party bundles
  // (Memory/Drizzle/Prisma) fill every slot, so this is a no-op for them.
  //
  // Version verbs are additionally gated behind model `versioning`: first-party
  // bundles ship their adapter slots, but auto-enabling `/:id/versions*` on a
  // non-versioned resource would surface routes that throw
  // VERSIONING_NOT_ENABLED at request time (and 4 dead paths per resource in
  // the OpenAPI doc). So they only default-on when the model declares
  // versioning. An explicit `only` still requests them (handled above).
  const versioningEnabled = isModelVersioningEnabled(config);
  const enabled = (e: CrudEndpointName) =>
    adapterProvidesEndpoint(config.adapters, e) &&
    (!VERSION_ENDPOINTS.has(e) || versioningEnabled);
  if (config.except) {
    const except = new Set<string>(config.except);
    return ALL_CRUD_ENDPOINTS.filter((e) => !except.has(e) && enabled(e));
  }
  return ALL_CRUD_ENDPOINTS.filter(enabled);
}

/**
 * True when the model opts into record versioning (`versioning: true` or a
 * config object). Mirrors hono-crud's getVersioningConfig, which treats any
 * truthy value as enabled and `false`/absent as disabled.
 */
function isModelVersioningEnabled(config: CrudConfig): boolean {
  const model = (config.meta as { model?: { versioning?: unknown } }).model;
  return Boolean(model?.versioning);
}

// Per-verb OpenAPI operationId naming. Single-record verbs use the SINGULAR
// resource name; list/bulk verbs use the PLURAL. Two verb remaps keep the
// generated client idiomatic: `read` -> `get`, `batch*` -> `bulk*`. Version
// verbs carry a `suffix` (Version/Versions) so they read `list{Noun}Versions`
// / `get{Noun}Version` / `compare{Noun}Versions` / `rollback{Noun}Version`; a
// per-endpoint `openapi.operationId` still wins.
const SLOT_NAMING: Partial<
  Record<CrudEndpointName, { verb: string; plural: boolean; suffix?: string; summaryNoun?: string }>
> = {
  create: { verb: 'create', plural: false },
  list: { verb: 'list', plural: true },
  read: { verb: 'get', plural: false },
  update: { verb: 'update', plural: false },
  delete: { verb: 'delete', plural: false },
  restore: { verb: 'restore', plural: false },
  upsert: { verb: 'upsert', plural: false },
  clone: { verb: 'clone', plural: false },
  search: { verb: 'search', plural: true },
  aggregate: { verb: 'aggregate', plural: true },
  export: { verb: 'export', plural: true },
  import: { verb: 'import', plural: true },
  bulkPatch: { verb: 'bulkPatch', plural: true },
  batchCreate: { verb: 'bulkCreate', plural: true },
  batchUpdate: { verb: 'bulkUpdate', plural: true },
  batchDelete: { verb: 'bulkDelete', plural: true },
  batchRestore: { verb: 'bulkRestore', plural: true },
  batchUpsert: { verb: 'bulkUpsert', plural: true },
  versionHistory: { verb: 'list', plural: false, suffix: 'Versions', summaryNoun: 'versions' },
  versionRead: { verb: 'get', plural: false, suffix: 'Version', summaryNoun: 'version' },
  versionCompare: { verb: 'compare', plural: false, suffix: 'Versions', summaryNoun: 'versions' },
  versionRollback: { verb: 'rollback', plural: false, suffix: 'Version', summaryNoun: 'version' },
};

const pascal = (s: string): string =>
  s.replace(/(?:^|[^a-zA-Z0-9]+)([a-zA-Z0-9])/g, (_m, c: string) => c.toUpperCase());

// "bulkDelete" -> "Bulk delete"
const humanizeVerb = (verb: string): string => {
  const words = verb.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

function resourceNames(config: CrudConfig): { singular: string; plural: string } {
  const singular =
    config.name ?? (config.meta as { model?: { tableName?: string } }).model?.tableName ?? 'item';
  const plural = config.namePlural ?? `${singular}s`;
  return { singular, plural };
}

/**
 * Inject a derived OpenAPI `operationId` + `summary` for the verb, unless the
 * user already set one (`endpoints.{name}.openapi.operationId` wins). Gives the
 * generated client stable, friendly names instead of method+path fallbacks.
 */
function mergeOperationId(
  name: CrudEndpointName,
  base: Record<string, unknown>,
  config: CrudConfig,
): Record<string, unknown> {
  const naming = SLOT_NAMING[name];
  if (!naming) return base;
  const existing = base.openapi as { operationId?: string; summary?: string } | undefined;
  if (existing?.operationId) return base;

  const { singular, plural } = resourceNames(config);
  const noun = naming.plural ? plural : singular;
  // A `suffix` (version verbs) appends to the operationId and picks a
  // sub-resource summary noun: `listDocumentVersions` / "List document versions".
  const operationId = `${naming.verb}${pascal(noun)}${naming.suffix ?? ''}`;
  const summary = naming.summaryNoun
    ? `${humanizeVerb(naming.verb)} ${singular} ${naming.summaryNoun}`
    : `${humanizeVerb(naming.verb)} ${naming.plural ? plural : `a ${singular}`}`;

  return { ...base, openapi: { operationId, summary, ...(existing ?? {}) } };
}

function buildEndpointsDef(
  config: CrudConfig,
  enabled: CrudEndpointName[],
): EndpointsConfig<MetaInput> {
  // Loud failure with a crud-level message when an EXPLICITLY requested verb
  // is not backed by the adapter bundle. Default-derived verbs were already
  // intersected away in resolveEnabledEndpoints, so only an explicit `only`
  // list or an explicit `endpoints.{verb}` key can reach here unsupported.
  // This pre-empts hono-crud's lower-level throw with an actionable message.
  const explicit = new Set<CrudEndpointName>([
    ...(config.only ?? []),
    ...((config.endpoints ? Object.keys(config.endpoints) : []) as CrudEndpointName[]),
  ]);
  const versioningEnabled = isModelVersioningEnabled(config);
  for (const name of explicit) {
    // A version verb requested via only/endpoints on a model that doesn't
    // declare `versioning` would 400 (VERSIONING_NOT_ENABLED) at request time.
    // Fail fast with the actual fix — declaring versioning — rather than the
    // misleading "adapter bundle has no X" error below (which fires for partial
    // bundles) or silently dropping the verb (first-party bundles).
    if (VERSION_ENDPOINTS.has(name) && !versioningEnabled) {
      throw new Error(
        `@Crud: endpoint '${name}' is a version verb, but the model does not ` +
          `declare \`versioning\`. Add \`versioning: true\` (or a config object) to ` +
          `the model's defineModel(...) to enable /:id/versions*, or remove ` +
          `'${name}' from only/endpoints.`,
      );
    }
    if (!adapterProvidesEndpoint(config.adapters, name)) {
      throw new Error(
        `@Crud: endpoint '${name}' was explicitly enabled but the adapter bundle ` +
          `has no ${crudEndpointSlot(name)}. Use an adapter bundle that ships ` +
          `${crudEndpointSlot(name)}, or remove '${name}' from only/endpoints.`,
      );
    }
  }

  // The mapped union of per-endpoint configs has no shared shape, so we build
  // the object as a plain Record and cast at the boundary. Each key lands in
  // the slot hono-crud expects at runtime.
  const baseFor = (name: CrudEndpointName) =>
    (config.endpoints?.[name] as Record<string, unknown> | undefined) ?? {};

  const entries = enabled.map(
    (name) =>
      [
        name,
        mergeOperationId(
          name,
          mergeDto(name, mergeFlatHooks(name, baseFor(name), config.hooks), config.dto),
          config,
        ),
      ] as const,
  );

  return { meta: config.meta, ...Object.fromEntries(entries) } as unknown as EndpointsConfig<MetaInput>;
}

function mergeDto(
  endpoint: CrudEndpointName,
  base: Record<string, unknown>,
  dtos: CrudConfig['dto'],
): Record<string, unknown> {
  // dto.create / dto.update map onto hono-crud's bodySchema field on the
  // matching endpoint config. Per-endpoint bodySchema set explicitly via
  // `endpoints.{name}.bodySchema` wins over the flat dto sugar.
  if (!dtos || (endpoint !== 'create' && endpoint !== 'update')) return base;
  const dto = dtos[endpoint];
  if (!dto || base.bodySchema !== undefined) return base;
  return { ...base, bodySchema: dto };
}

function mergeFlatHooks(
  endpoint: CrudEndpointName,
  base: Record<string, unknown>,
  flat: CrudConfig['hooks'],
): Record<string, unknown> {
  if (!flat) return base;
  const cap = endpoint.charAt(0).toUpperCase() + endpoint.slice(1);
  const before = flat[`before${cap}` as keyof typeof flat] as
    | ((...args: unknown[]) => unknown)
    | undefined;
  const after = flat[`after${cap}` as keyof typeof flat] as
    | ((...args: unknown[]) => unknown)
    | undefined;
  if (!before && !after) return base;

  const existing = (base.hooks as Record<string, unknown> | undefined) ?? {};

  // hono-crud invokes most handlers as `(data, ctx)`. velajs flat sugar is
  // `(ctx, data)` — flip args and forward. Per-endpoint hooks attached
  // via endpoints.{name}.hooks win over flat sugar.
  const flipBefore = before
    ? (data: unknown, ctx: unknown) => (before as (c: unknown, d: unknown) => unknown)(ctx, data)
    : undefined;

  // hono-crud 0.10.0 widened the after-update/after-delete shape:
  //   afterUpdate: (prior, current, ctx)   — UPDATE
  //   afterDelete: (prior, ctx)            — DELETE
  //   afterCreate / afterList / afterRead: (data, ctx)  — unchanged
  // Flat sugar mirrors that shape with ctx hoisted to first arg, so the
  // wrapper picks the right flip per endpoint.
  let flipAfter: ((...args: unknown[]) => unknown) | undefined;
  if (after) {
    if (endpoint === 'update') {
      flipAfter = (prior: unknown, current: unknown, ctx: unknown) =>
        (after as (c: unknown, p: unknown, cur: unknown) => unknown)(ctx, prior, current);
    } else if (endpoint === 'delete') {
      flipAfter = (prior: unknown, ctx: unknown) =>
        (after as (c: unknown, p: unknown) => unknown)(ctx, prior);
    } else {
      flipAfter = (data: unknown, ctx: unknown) =>
        (after as (c: unknown, d: unknown) => unknown)(ctx, data);
    }
  }

  return {
    ...base,
    hooks: {
      ...existing,
      ...(flipBefore ? { before: existing.before ?? flipBefore } : {}),
      ...(flipAfter ? { after: existing.after ?? flipAfter } : {}),
    },
  };
}

function buildOverrideMiddlewares(controller: Type): EndpointMiddlewares {
  const overrides = getOverrides(controller);
  if (overrides.length === 0) return {};

  const proto = controller.prototype as Record<string | symbol, unknown>;
  const result: EndpointMiddlewares = {};

  for (const { endpoint, methodName } of overrides) {
    const handler = proto[methodName];
    if (typeof handler !== 'function') continue;

    const middleware: MiddlewareHandler = async (c) => {
      // Prototype-bound: overrides are called without instance state. The
      // method should produce a Hono response from the context directly.
      const fn = handler as (this: unknown, c: Context) => ReturnType<MiddlewareHandler>;
      return fn.call(proto, c);
    };

    const list = result[endpoint] ?? [];
    list.push(middleware);
    result[endpoint] = list;
  }

  return result;
}

function buildGuardMiddleware(
  controller: Type,
  globalGuards: CanActivate[],
  container: Container | undefined,
): MiddlewareHandler[] {
  // `getScopedComponents` returns the controller + handler tiers. The old
  // `getComponents` also prepended an app-wide tier, but that tier was always
  // empty on this path (CRUD controllers register no global components), so
  // this is behaviorally identical — app-wide guards arrive via `globalGuards`.
  const guardItems = ComponentManager.getScopedComponents('guard', controller, '' as string | symbol);
  const guards =
    guardItems.length > 0 && container
      ? ComponentManager.resolveGuards(guardItems, container)
      : [];
  if (guards.length === 0 && globalGuards.length === 0) return [];

  const allGuards = [...globalGuards, ...guards];

  const guardMiddleware: MiddlewareHandler = async (c, next) => {
    // Cast (not annotate) so this compiles against BOTH vela ExecutionContext
    // shapes across the supported peer range (`>=1.8.3`): pre-1.9 has no
    // `switchToWs` (here it's a harmless extra the assertion tolerates), while
    // >=1.9 requires it. `switchToWs` mirrors vela's own HTTP ExecutionContext
    // (throws — this bridge runs over HTTP, not a WebSocket gateway).
    const executionContext = {
      getType: <T extends string = 'http'>() => 'http' as T,
      getClass: () => controller,
      getHandler: () => 'crud',
      getContext: <T = Context>() => c as T,
      getRequest: () => c.req.raw,
      switchToHttp: (): HttpArgumentsHost => ({
        getRequest: <T>() => c.req.raw as T,
        getResponse: <T = Context>() => c as T,
      }),
      switchToWs: () => {
        throw new Error(
          'switchToWs() called on an HTTP ExecutionContext. This handler runs over HTTP, not a WebSocket gateway.',
        );
      },
    } as ExecutionContext;

    for (const guard of allGuards) {
      const canActivate = await guard.canActivate(executionContext);
      if (!canActivate) {
        throw new ForbiddenException();
      }
    }

    return next();
  };

  return [guardMiddleware];
}

/**
 * Resolve controller-level `@UseMiddleware(...)` and wrap each instance as a
 * Hono middleware. Mirrors vela's `RouteManager` first pass, which reads
 * `ComponentManager.getScopedComponents('middleware', controller, route.handlerName)`
 * and applies `instance.use(c, next)` per route. Here the handler-name slot is
 * the empty string so only the controller scope is pulled — handler-scoped
 * middleware has no generated handler to bind to. This is the exact pattern
 * {@link buildGuardMiddleware} uses for guards.
 */
function buildControllerMiddleware(
  controller: Type,
  container: Container | undefined,
): MiddlewareHandler[] {
  const middlewareItems = ComponentManager.getScopedComponents(
    'middleware',
    controller,
    '' as string | symbol,
  );
  if (middlewareItems.length === 0 || !container) return [];

  const instances = ComponentManager.resolveMiddleware(middlewareItems, container);

  // Mirror vela's RouteManager: invoke `instance.use(c, next)` and return its
  // result directly — Hono assigns a returned Response or honors the
  // `next()`-driven chain, so a NestMiddleware that short-circuits and one
  // that passes through both behave exactly as on a hand-written route. The
  // `c`/`next` casts bridge the Hono context-generic variance between this
  // package's `hono` and vela's `NestMiddleware.use` signature (the same
  // friction `buildGuardMiddleware` resolves with its `c as T` casts).
  type UseArgs = Parameters<NestMiddleware['use']>;
  return instances.map<MiddlewareHandler>(
    (instance) => (c, next) =>
      instance.use(c as unknown as UseArgs[0], next as unknown as UseArgs[1]),
  );
}

async function loadHonoCrud(): Promise<HonoCrudModule> {
  try {
    const mod = (await import('hono-crud')) as unknown as Omit<
      HonoCrudModule,
      'recordCrudResource'
    >;
    // recordCrudResource lives on the satellite-facing `hono-crud/internal`
    // surface (not the root barrel).
    const internal = (await import('hono-crud/internal')) as unknown as Pick<
      HonoCrudModule,
      'recordCrudResource'
    >;
    return { ...mod, recordCrudResource: internal.recordCrudResource };
  } catch {
    throw new Error(
      `@Crud() requires 'hono-crud' as a dependency. Install it: pnpm add hono-crud`,
    );
  }
}

async function loadHonoZodOpenapi(): Promise<HonoZodOpenapiModule> {
  try {
    const mod = (await import('@hono/zod-openapi')) as unknown as HonoZodOpenapiModule;
    return mod;
  } catch {
    throw new Error(
      `@Crud() requires '@hono/zod-openapi' as a dependency. Install it: pnpm add @hono/zod-openapi`,
    );
  }
}
