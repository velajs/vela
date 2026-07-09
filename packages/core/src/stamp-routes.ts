/**
 * Route stamping: turns a `CrudConfig` into REAL controller routes — the same
 * metadata hand-written `@Get`/`@Post` decorators produce. Everything flows
 * through RouteManager's normal pass: first-class `vela route list`, named
 * routes (`urlFor`), signed routes, the full guard/pipe/interceptor pipeline,
 * and OpenAPI via the ordinary controller walk. No RouteContributor.
 *
 * Synthesized methods have no `design:paramtypes`, so each stamped parameter
 * carries its DTO class as an explicit `metatype` (vela >= 1.18 reads it in
 * ValidationPipe and the OpenAPI walk).
 */

import type { Context } from 'hono';
import {
  ApiDoc,
  ApiTags,
  Delete,
  Get,
  MetadataRegistry,
  ParamType,
  Patch,
  Post,
  Put,
  defineMetadata,
  getMetadata,
  getRequestContainer,
  METADATA_KEYS,
} from '@velajs/vela';
import type { CrudAdapter } from './adapter/contract';
import { ConfigurationException } from './envelope/errors';
import { defineResource, type CrudResource, type ResourceConfig } from './kernel/resource';
import { deriveCreateSchema, deriveUpdateSchema } from './model/schema-derive';
import { deriveRouteName, deriveVerbNaming } from './naming';
import { buildEngineRequest, toResponse } from './request-flow';
import { CRUD_DEFAULT_ADAPTER } from './crud.tokens';
import { MissingTenantResolverError, resourceNames, type CrudConfig } from './crud.types';
import { implementedEndpoints } from './kernel/extended/registry';
import {
  CRUD_ROUTES,
  resolveEnabledEndpoints,
  type CrudEndpointName,
} from './verb-table';
import { createZodDto } from '@velajs/vela';

const OVERRIDES_KEY = 'velajs:crud:overrides';

/** Read the `@Override(verb)` map stamped on a controller class. */
export function getOverrides(target: object): Partial<Record<CrudEndpointName, string | symbol>> {
  return (getMetadata(OVERRIDES_KEY, target) as Partial<Record<CrudEndpointName, string | symbol>>) ?? {};
}

export function recordOverride(target: object, endpoint: CrudEndpointName, method: string | symbol): void {
  defineMetadata(OVERRIDES_KEY, { ...getOverrides(target), [endpoint]: method }, target);
}

const ROUTE_DECORATORS = { get: Get, post: Post, put: Put, patch: Patch, delete: Delete } as const;

const pascal = (s: string): string =>
  s.replace(/(?:^|[^a-zA-Z0-9]+)([a-zA-Z0-9])/g, (_m, c: string) => c.toUpperCase());

type Ctor = new (...args: never[]) => unknown;

/**
 * Applies the full CRUD stamping to a controller class. Called by the
 * `@Crud()` class decorator and by `synthesizeController` (headless
 * resources) — one implementation, two entry points.
 */
export function stampCrudRoutes(controller: Ctor, config: CrudConfig): void {
  const model = config.model;
  const names = resourceNames(config);

  // Fail-fast tenant affirmation: silent tenant-isolation loss is a
  // data-loss class, so a tenant-scoped model demands the explicit flag.
  if (model.tenantField !== undefined && config.tenantResolverMounted !== true) {
    throw new MissingTenantResolverError({
      mountPath: controller.name,
      tableName: model.tableName,
    });
  }

  const implemented = implementedEndpoints();
  const enabled = resolveEnabledEndpoints(model, { only: config.only, except: config.except });
  const skipped = enabled.filter((name) => !implemented.includes(name));
  if (skipped.length > 0) {
    console.warn(
      `[@velajs/crud] ${controller.name}: verbs not yet implemented by the native engine ` +
        `and skipped: ${skipped.join(', ')}`,
    );
  }
  const stamped = enabled.filter((name) => implemented.includes(name));

  // DTO bridge — derived once per class, adapter-independent.
  const base = pascal(names.singular);
  const createDto = createZodDto(config.dto?.create ?? deriveCreateSchema(model), {
    name: `Create${base}Dto`,
  });
  const updateDto = createZodDto(
    config.dto?.update ?? deriveUpdateSchema(model, config.updateFields ?? {}),
    { name: `Update${base}Dto` },
  );

  // The compiled engine resource: lazy (the adapter may come from DI) and
  // memoized per class.
  let compiled: CrudResource | undefined;
  const resolveResource = (c: Context): CrudResource => {
    if (compiled) return compiled;
    const adapter =
      config.adapter ?? tryResolveDefaultAdapter(c) ??
      raiseNoAdapter(controller.name, names.singular);
    compiled = defineResource(names.singular, toEngineConfig(config, adapter));
    return compiled;
  };

  const overrides = getOverrides(controller);
  defineMetadata(METADATA_KEYS.CRUD, config, controller);
  ApiTags(...(config.tags ?? [names.plural]))(controller);

  for (const [endpoint, method, subPath] of CRUD_ROUTES) {
    if (!stamped.includes(endpoint)) continue;

    const overrideMethod = overrides[endpoint];
    const handlerName = overrideMethod ?? `crud$${endpoint}`;

    if (overrideMethod === undefined) {
      defineHandler(controller, handlerName as string, endpoint, resolveResource);
      stampParams(controller, handlerName as string, endpoint, createDto, updateDto);
    }

    // Route (real metadata → RouteManager first pass) + name for urlFor.
    const decorate = ROUTE_DECORATORS[method];
    decorate(subPath, { name: deriveRouteName(names.singular, endpoint) })(
      controller.prototype as object,
      handlerName,
      Object.getOwnPropertyDescriptor(controller.prototype, handlerName) ?? {
        value: (controller.prototype as Record<string | symbol, unknown>)[handlerName],
        writable: true,
        configurable: true,
      },
    );

    const naming = deriveVerbNaming(endpoint, names.singular, names.plural);
    if (naming) {
      ApiDoc({ operationId: naming.operationId, summary: naming.summary })(
        controller.prototype as object,
        handlerName,
        Object.getOwnPropertyDescriptor(controller.prototype, handlerName) as never,
      );
    }
  }
}

function defineHandler(
  controller: Ctor,
  handlerName: string,
  endpoint: CrudEndpointName,
  resolveResource: (c: Context) => CrudResource,
): void {
  const handler = buildVerbHandler(endpoint, resolveResource);
  Object.defineProperty(controller.prototype, handlerName, {
    value: handler,
    writable: true,
    configurable: true,
  });
}

/**
 * Shape of each verb's synthesized handler: which path params it takes and
 * whether it carries a request body. Single table for all 22 verbs — the
 * handler builder and param stamping both derive from it, so adding an
 * executor family never touches this file.
 */
const VERB_SHAPES: Record<CrudEndpointName, { id?: boolean; version?: boolean; body?: boolean }> = {
  create: { body: true },
  list: {},
  batchCreate: { body: true },
  batchUpdate: { body: true },
  batchDelete: { body: true },
  batchRestore: { body: true },
  batchUpsert: { body: true },
  search: {},
  aggregate: {},
  export: {},
  import: { body: true },
  upsert: { body: true },
  bulkPatch: { body: true },
  read: { id: true },
  update: { id: true, body: true },
  delete: { id: true },
  restore: { id: true },
  clone: { id: true, body: true },
  versionHistory: { id: true },
  versionCompare: { id: true },
  versionRead: { id: true, version: true },
  versionRollback: { id: true, version: true },
};

function buildVerbHandler(
  endpoint: CrudEndpointName,
  resolveResource: (c: Context) => CrudResource,
): (...args: unknown[]) => Promise<Response> {
  const shape = VERB_SHAPES[endpoint];
  // Arg order mirrors the stamped param order: [id?, version?, body?, ctx].
  return async function crudHandler(...args: unknown[]): Promise<Response> {
    let cursor = 0;
    const id = shape.id ? String(args[cursor++]) : undefined;
    const version = shape.version ? String(args[cursor++]) : undefined;
    const body = shape.body ? args[cursor++] : undefined;
    const ctx = args[cursor] as Context;
    const resource = resolveResource(ctx);
    return toResponse(
      ctx,
      await resource.execute(
        endpoint,
        buildEngineRequest(ctx, {
          id,
          body,
          ...(version !== undefined ? { params: { version } } : {}),
        }),
      ),
    );
  };
}

function stampParams(
  controller: Ctor,
  handlerName: string,
  endpoint: CrudEndpointName,
  createDto: unknown,
  updateDto: unknown,
): void {
  const add = (param: {
    index: number;
    type: string;
    name?: string;
    metatype?: unknown;
  }): void => MetadataRegistry.addParameter(controller as never, handlerName, param as never);

  const shape = VERB_SHAPES[endpoint];
  let index = 0;
  if (shape.id) add({ index: index++, type: ParamType.PARAM, name: 'id' });
  if (shape.version) add({ index: index++, type: ParamType.PARAM, name: 'version' });
  if (shape.body) {
    // create/update carry their derived DTOs (ValidationPipe + OpenAPI);
    // extended verbs validate in the engine — their body docs land with the
    // OpenAPI parity pass (M6).
    const metatype =
      endpoint === 'create' ? createDto : endpoint === 'update' ? updateDto : undefined;
    add({ index: index++, type: ParamType.BODY, ...(metatype ? { metatype } : {}) });
  }
  add({ index, type: ParamType.REQUEST });
}

function tryResolveDefaultAdapter(c: Context): CrudAdapter | undefined {
  try {
    return getRequestContainer(c).resolve(CRUD_DEFAULT_ADAPTER);
  } catch {
    return undefined;
  }
}

function raiseNoAdapter(controllerName: string, resource: string): never {
  throw new ConfigurationException(
    `${controllerName} ('${resource}'): no adapter available — pass 'adapter' in the @Crud() ` +
      `config or provide a default via CrudModule.forRoot({ adapter })`,
  );
}

/** Maps the consumer config onto the engine's `ResourceConfig`. */
export function toEngineConfig(config: CrudConfig, adapter: CrudAdapter): ResourceConfig {
  return {
    model: config.model,
    adapter,
    hooks: config.hooks,
    filterFields: config.filterFields,
    filterConfig: config.filterConfig,
    sortFields: config.sortFields,
    defaultSort: config.defaultSort,
    searchFields: config.searchFields,
    allowedIncludes: config.allowedIncludes,
    fieldSelection: config.fieldSelection,
    pagination: config.pagination,
    upsert: config.upsert,
    batch: config.batch,
    bulkPatch: config.bulkPatch,
    search: config.search,
    aggregate: config.aggregate,
    dto: config.dto,
    updateFields: config.updateFields,
    envelope: config.responseEnvelope,
    errorMappers: config.errorMappers,
  };
}
