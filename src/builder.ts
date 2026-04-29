import type { Context, Hono, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { CanActivate, ExecutionContext, HttpArgumentsHost, Type } from '@velajs/vela';
import { ComponentManager, ForbiddenException, HttpException } from '@velajs/vela';
import type {
  AdapterBundle,
  EndpointMiddlewares,
  EndpointsConfig,
  GeneratedEndpoints,
  MetaInput,
  RegisterCrudOptions,
} from 'hono-crud';
import { getOverrides } from './override.decorator';
import { ALL_CRUD_ENDPOINTS, type CrudConfig, type CrudEndpointName } from './types';

interface BuilderContext {
  globalPrefix: string;
  globalGuards: CanActivate[];
  joinPaths: (...parts: string[]) => string;
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
  validateEndpointNames(crudConfig);

  const { fromHono, registerCrud, defineEndpoints } = await loadHonoCrud();
  const { OpenAPIHono } = await loadHonoZodOpenapi();

  const enabledEndpoints = resolveEnabledEndpoints(crudConfig);
  const endpointsDef = buildEndpointsDef(crudConfig, enabledEndpoints);
  const endpoints = defineEndpoints(endpointsDef, crudConfig.adapters);

  const middlewares = buildGuardMiddleware(controller, ctx.globalGuards);
  const endpointMiddlewares = buildOverrideMiddlewares(controller);

  const openApiHono = new OpenAPIHono();
  openApiHono.onError((err, c) => {
    if (err instanceof HttpException) {
      return c.json(err.getResponse(), err.getStatus() as ContentfulStatusCode);
    }
    return c.json({ statusCode: 500, message: 'Internal Server Error' }, 500);
  });

  const subApp = fromHono(openApiHono);
  registerCrud(subApp, '', endpoints, {
    middlewares: middlewares.length > 0 ? middlewares : undefined,
    endpointMiddlewares: Object.keys(endpointMiddlewares).length > 0 ? endpointMiddlewares : undefined,
  });

  const mountPath = ctx.joinPaths(ctx.globalPrefix, prefix) || '/';
  app.route(mountPath, subApp);
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
  if (config.only) return [...config.only];
  if (config.except) {
    const except = new Set<string>(config.except);
    return ALL_CRUD_ENDPOINTS.filter((e) => !except.has(e));
  }
  return [...ALL_CRUD_ENDPOINTS];
}

function buildEndpointsDef(
  config: CrudConfig,
  enabled: CrudEndpointName[],
): EndpointsConfig<MetaInput> {
  // The mapped union of per-endpoint configs has no shared shape, so we build
  // the object as a plain Record and cast at the boundary. Each key lands in
  // the slot hono-crud expects at runtime.
  const baseFor = (name: CrudEndpointName) =>
    (config.endpoints?.[name] as Record<string, unknown> | undefined) ?? {};

  const entries = enabled.map(
    (name) => [name, mergeDto(name, mergeFlatHooks(name, baseFor(name), config.hooks), config.dto)] as const,
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
  const before = flat[`before${cap}` as keyof typeof flat];
  const after = flat[`after${cap}` as keyof typeof flat];
  if (!before && !after) return base;

  const existing = (base.hooks as Record<string, unknown> | undefined) ?? {};
  return {
    ...base,
    hooks: {
      ...existing,
      ...(before ? { before: existing.before ?? before } : {}),
      ...(after ? { after: existing.after ?? after } : {}),
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

function buildGuardMiddleware(controller: Type, globalGuards: CanActivate[]): MiddlewareHandler[] {
  const guardItems = ComponentManager.getComponents('guard', controller, '' as string | symbol);
  const guards = ComponentManager.resolveGuards(guardItems);
  if (guards.length === 0 && globalGuards.length === 0) return [];

  const allGuards = [...globalGuards, ...guards];

  const guardMiddleware: MiddlewareHandler = async (c, next) => {
    const executionContext: ExecutionContext = {
      getType: <T extends string = 'http'>() => 'http' as T,
      getClass: () => controller,
      getHandler: () => 'crud',
      getContext: <T = Context>() => c as T,
      getRequest: () => c.req.raw,
      switchToHttp: (): HttpArgumentsHost => ({
        getRequest: <T>() => c.req.raw as T,
        getResponse: <T = Context>() => c as T,
      }),
    };

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

async function loadHonoCrud(): Promise<HonoCrudModule> {
  try {
    const mod = (await import('hono-crud')) as unknown as HonoCrudModule;
    return mod;
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
