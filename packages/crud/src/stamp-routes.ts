/**
 * Route stamping: turns a `CrudConfig` into REAL controller routes — the same
 * metadata hand-written `@Get`/`@Post` decorators produce. Everything flows
 * through RouteManager's normal pass: first-class `vela route list`, named
 * routes (`urlFor`), signed routes, the full guard/pipe/interceptor pipeline,
 * and OpenAPI via the ordinary controller walk. No RouteContributor.
 *
 * Synthesized methods have no `design:paramtypes`, so each stamped parameter
 * carries its DTO descriptor as an explicit `metatype` (Vela reads it in
 * ValidationPipe and the OpenAPI walk).
 */

import { Context } from 'hono';
import {
  ApiDoc,
  ApiResponse,
  ApiTags,
  Delete,
  Get,
  MetadataRegistry,
  ParamType,
  Patch,
  Post,
  Put,
  UseGuards,
  defineDto,
  isStandardSchema,
  defineMetadata,
  getMetadata,
  getRequestContainer,
  METADATA_KEYS,
  type DtoDefinition,
  type StandardDtoDefinition,
} from '@velajs/vela';
import type { RuntimeAdapter } from './adapter/contract';
import { ConfigurationException } from './envelope/errors';
import { compileResource, type CrudResource, type RuntimeResourceConfig } from './kernel/resource';
import { deriveCreateSchema, deriveUpdateSchema } from './model/schema-derive';
import { deriveRouteName, deriveVerbNaming, pascalResourceName } from './naming';
import { buildEngineRequest, toResponse } from './request-flow';
import { resolveCrudDatabase } from './resolve-database';
import {
  MissingTenantResolverError,
  registerCrudConfig,
  resourceNames,
  type RuntimeCrudConfig,
} from './crud.types';
import { buildLiveStamper, type LiveStamper } from './live-bridge';
import { implementedEndpoints } from './kernel/extended/registry';
import { CRUD_ROUTES, resolveEnabledEndpoints, type CrudEndpointName } from './verb-table';

const OVERRIDES_KEY = 'velajs:crud:overrides';

/** Read the `@Override(verb)` map stamped on a controller class. */
export function getOverrides(target: object): Partial<Record<CrudEndpointName, string | symbol>> {
  const metadata = getMetadata(OVERRIDES_KEY, target);
  if (metadata === undefined) return {};
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new ConfigurationException('CRUD override metadata must be an endpoint-to-method map');
  }
  const overrides: Partial<Record<CrudEndpointName, string | symbol>> = {};
  const entries: [string, unknown][] = Object.entries(metadata);
  for (const [name, method] of entries) {
    const endpoint = CRUD_ROUTES.find(([candidate]) => candidate === name)?.[0];
    if (endpoint === undefined || (typeof method !== 'string' && typeof method !== 'symbol')) {
      throw new ConfigurationException(`Invalid CRUD override metadata for '${name}'`);
    }
    overrides[endpoint] = method;
  }
  return overrides;
}

export function recordOverride(
  target: object,
  endpoint: CrudEndpointName,
  method: string | symbol,
): void {
  defineMetadata(OVERRIDES_KEY, { ...getOverrides(target), [endpoint]: method }, target);
}

const ROUTE_DECORATORS = { get: Get, post: Post, put: Put, patch: Patch, delete: Delete } as const;

type Ctor = {
  new (...args: never[]): unknown;
  readonly prototype: object;
};

/**
 * Applies the full CRUD stamping to a controller class. Called by the
 * `@Crud()` class decorator and by `synthesizeController` (headless
 * resources) — one implementation, two entry points.
 */
export function stampCrudRoutes(controller: Ctor, config: RuntimeCrudConfig): void {
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
  const base = pascalResourceName(names.singular);
  const createDto = defineDto(
    config.contracts?.create ??
      model.contracts?.create ??
      config.dto?.create ??
      deriveCreateSchema(model),
    {
      name: `Create${base}Dto`,
    },
  );
  const updateDto = defineDto(
    config.contracts?.update ??
      model.contracts?.update ??
      config.dto?.update ??
      deriveUpdateSchema(model, config.updateFields ?? {}),
    { name: `Update${base}Dto` },
  );

  // The compiled engine resource: lazy (the adapter may come from DI) and
  // resolved within the current request so environments never share bindings.
  const resolveResource = async (c: Context): Promise<CrudResource> => {
    const resolved = await resolveCrudDatabase(getRequestContainer(c), config);
    const engineConfig = toEngineConfig(resolved, resolved.adapter);
    if (
      !model.resolveSchema &&
      isStandardSchema(createDto.schema) &&
      isStandardSchema(updateDto.schema)
    )
      engineConfig.contracts = {
        ...model.contracts,
        ...config.contracts,
        create: createDto.schema,
        update: updateDto.schema,
      };
    return compileResource(names.singular, engineConfig);
  };

  const overrides = getOverrides(controller);
  const liveStamper = buildLiveStamper(config);
  registerCrudConfig(controller, config);
  defineMetadata(METADATA_KEYS.CRUD, config, controller);
  ApiTags(...(config.tags ?? [names.plural]))(controller);

  for (const [endpoint, method, subPath] of CRUD_ROUTES) {
    if (!stamped.includes(endpoint)) continue;

    const overrideMethod = overrides[endpoint];
    const handlerName = overrideMethod ?? `crud$${endpoint}`;

    if (overrideMethod === undefined) {
      defineHandler(controller, handlerName, endpoint, method, resolveResource, liveStamper);
      stampParams(controller, handlerName, endpoint, createDto, updateDto);
    }

    // Route (real metadata → RouteManager first pass) + name for urlFor.
    const decorate = ROUTE_DECORATORS[method];
    const proto = controller.prototype;
    const handler: unknown = Reflect.get(proto, handlerName);
    if (typeof handler !== 'function') {
      throw new ConfigurationException(
        `${controller.name}: CRUD override '${String(handlerName)}' must be a method`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(proto, handlerName) ?? {
      value: handler,
      writable: true,
      configurable: true,
    };
    const path =
      config.model.primaryKeys.length > 1
        ? subPath.replace('/:id', config.model.primaryKeys.map((key) => `/:${key}`).join(''))
        : subPath;
    decorate(path, {
      name: deriveRouteName(
        config.database === undefined ? names.singular : `${config.database}:${names.singular}`,
        endpoint,
      ),
    })(proto, handlerName, descriptor);

    const naming = deriveVerbNaming(
      endpoint,
      config.database === undefined ? names.singular : `${config.database}_${names.singular}`,
      config.database === undefined ? names.plural : `${config.database}_${names.plural}`,
    );
    if (naming) {
      ApiDoc({ operationId: naming.operationId, summary: naming.summary })(
        proto,
        handlerName,
        descriptor,
      );
    }

    // Canonical response statuses so the OpenAPI walk documents each verb:
    // success (201 create, 200 otherwise), 404 for id-addressed verbs, and
    // 400 for body-validated ones.
    const shape = VERB_SHAPES[endpoint];
    ApiResponse(endpoint === 'create' ? 201 : 200, {
      description: naming?.summary ?? `${endpoint} ${names.singular}`,
    })(proto, handlerName, descriptor);
    if (shape.id) {
      ApiResponse(404, { description: `${names.singular} not found` })(
        proto,
        handlerName,
        descriptor,
      );
    }
    if (shape.body) {
      ApiResponse(400, { description: 'Validation failed' })(proto, handlerName, descriptor);
    }

    // Per-endpoint guards: the same metadata a hand-written @UseGuards on this
    // method would produce. Stamped for @Override'd handlers too — the guard
    // is endpoint policy, so an override must not silently drop it.
    const endpointGuards = config.guards?.[endpoint];
    if (endpointGuards?.length) {
      UseGuards(...endpointGuards)(proto, handlerName);
    }
  }
}

function defineHandler(
  controller: Ctor,
  handlerName: string | symbol,
  endpoint: CrudEndpointName,
  method: string,
  resolveResource: (c: Context) => Promise<CrudResource>,
  liveStamper: LiveStamper | undefined,
): void {
  const handler = buildVerbHandler(endpoint, method, resolveResource, liveStamper);
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
  method: string,
  resolveResource: (c: Context) => Promise<CrudResource>,
  liveStamper: LiveStamper | undefined,
): (...args: unknown[]) => Promise<Response> {
  const shape = VERB_SHAPES[endpoint];
  // Arg order mirrors the stamped param order: [id?, version?, body?, ctx].
  return async function crudHandler(...args: unknown[]): Promise<Response> {
    let cursor = 0;
    const idValue = shape.id ? args[cursor++] : undefined;
    const id = idValue === undefined ? undefined : String(idValue);
    const version = shape.version ? String(args[cursor++]) : undefined;
    const body = shape.body ? args[cursor++] : undefined;
    const ctx = args[cursor];
    if (!(ctx instanceof Context)) {
      throw new ConfigurationException('A generated CRUD handler requires a Hono Context');
    }
    const resource = await resolveResource(ctx);
    const result = await resource.execute(
      endpoint,
      buildEngineRequest(ctx, {
        id,
        body,
        ...(version !== undefined ? { params: { version } } : {}),
      }),
    );
    // Post-commit, pre-flush: invalidate live tags + merge commit headers.
    if (liveStamper) await liveStamper(ctx, result, method);
    return toResponse(ctx, result);
  };
}

function stampParams(
  controller: Ctor,
  handlerName: string | symbol,
  endpoint: CrudEndpointName,
  createDto: DtoDefinition<unknown> | StandardDtoDefinition<unknown, unknown>,
  updateDto: DtoDefinition<unknown> | StandardDtoDefinition<unknown, unknown>,
): void {
  const add = (param: { index: number; type: string; name?: string; metatype?: unknown }): void =>
    MetadataRegistry.addParameter(controller, handlerName, param);

  const shape = VERB_SHAPES[endpoint];
  let index = 0;
  if (shape.id) add({ index: index++, type: ParamType.PARAM, name: 'id' });
  if (shape.version) add({ index: index++, type: ParamType.PARAM, name: 'version' });
  if (shape.body) {
    // create/update document their derived DTOs; the engine owns validation.
    // Passing raw input avoids repeated transforms and cross-request receipts.
    // extended verbs validate in the engine — their body docs land with the
    // OpenAPI parity pass (M6).
    const metatype =
      endpoint === 'create' ? createDto : endpoint === 'update' ? updateDto : undefined;
    add({
      index: index++,
      type: ParamType.BODY,
      ...(metatype ? { metatype: Object.freeze({ ...metatype, validationOwner: 'handler' }) } : {}),
    });
  }
  add({ index, type: ParamType.REQUEST });
}

/** Maps the validated consumer config onto the engine's runtime configuration. */
export function toEngineConfig(
  config: RuntimeCrudConfig,
  adapter: RuntimeAdapter,
): RuntimeResourceConfig {
  return {
    model: config.model,
    database: config.database,
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
    etag: config.etag,
    upsert: config.upsert,
    clone: config.clone,
    batch: config.batch,
    bulkPatch: config.bulkPatch,
    search: config.search,
    aggregate: config.aggregate,
    dto: config.dto,
    contracts: config.contracts,
    collection: config.collection,
    authorization: config.authorization,
    projectPage: config.projectPage,
    afterCommit: config.afterCommit,
    onAfterCommitError: config.onAfterCommitError,
    updateFields: config.updateFields,
    versioningStore: config.versioningStore,
    auditStore: config.auditStore,
    envelope: config.responseEnvelope,
    errorMappers: config.errorMappers,
  };
}
