import type { Context, Hono } from 'hono';
import type { CanActivate, ExecutionContext, Type } from '@velajs/vela';
import { ComponentManager } from '@velajs/vela';
import type { CrudConfig, CrudEndpointName } from './types';

interface BuilderContext {
  globalPrefix: string;
  globalGuards: CanActivate[];
  joinPaths: (...parts: string[]) => string;
}

export async function buildCrudRoutes(
  app: Hono,
  controller: Type,
  prefix: string,
  crudConfig: CrudConfig,
  ctx: BuilderContext,
): Promise<void> {
  // Dynamic import of optional peer dependencies
  let fromHono: Function;
  let registerCrud: Function;
  let defineEndpoints: Function;
  let OpenAPIHono: new () => unknown;

  try {
    const [honoCrud, honoZodOpenapi] = await Promise.all([
      import('hono-crud'),
      import('@hono/zod-openapi'),
    ]);
    fromHono = honoCrud.fromHono;
    registerCrud = honoCrud.registerCrud;
    defineEndpoints = honoCrud.defineEndpoints;
    OpenAPIHono = honoZodOpenapi.OpenAPIHono;
  } catch {
    throw new Error(
      `@Crud() requires 'hono-crud' and '@hono/zod-openapi' as dependencies. ` +
      `Install them: bun add hono-crud @hono/zod-openapi`,
    );
  }

  // Determine which CRUD operations to enable
  const allEndpoints: CrudEndpointName[] =
    ['create', 'list', 'read', 'update', 'delete'];

  let enabledEndpoints = allEndpoints;
  if (crudConfig.only) {
    enabledEndpoints = crudConfig.only;
  } else if (crudConfig.except) {
    enabledEndpoints = allEndpoints.filter((e) => !crudConfig.except!.includes(e));
  }

  // Build config for defineEndpoints
  const endpointsDef: Record<string, unknown> = { meta: crudConfig.meta };
  for (const name of enabledEndpoints) {
    endpointsDef[name] = crudConfig.endpoints?.[name] ?? {};
  }

  // Generate endpoint classes via hono-crud
  const endpoints = defineEndpoints(endpointsDef, crudConfig.adapters);

  // Convert vela guards → Hono middleware for CRUD routes
  const guardItems = ComponentManager.getComponents('guard', controller, '' as string | symbol);
  const guards = ComponentManager.resolveGuards(guardItems);
  const middlewares: Function[] = [];

  if (guards.length > 0 || ctx.globalGuards.length > 0) {
    const allGuards = [...ctx.globalGuards, ...guards];

    const guardMiddleware = async (c: Context, next: Function) => {
      const executionContext: ExecutionContext = {
        getClass: () => controller,
        getHandler: () => 'crud',
        getContext: <T = Context>() => c as T,
        getRequest: () => c.req.raw,
      };

      for (const guard of allGuards) {
        const canActivate = await guard.canActivate(executionContext);
        if (!canActivate) {
          return c.json({ statusCode: 403, message: 'Forbidden' }, 403);
        }
      }

      return next();
    };

    middlewares.push(guardMiddleware);
  }

  // Create OpenAPIHono sub-app, proxy it via fromHono, register CRUD endpoints
  const subApp = fromHono(new OpenAPIHono());
  registerCrud(subApp, '', endpoints, {
    middlewares: middlewares.length > 0 ? middlewares : undefined,
  });

  // Mount sub-app at controller prefix
  const mountPath = ctx.joinPaths(ctx.globalPrefix, prefix) || '/';
  app.route(mountPath, subApp);
}
