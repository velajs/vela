import type { Context, Hono, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { CanActivate, ExecutionContext, HttpArgumentsHost, Type } from '@velajs/vela';
import { ComponentManager, ForbiddenException, HttpException } from '@velajs/vela';
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
  // These are typed generically because we call them with runtime-dynamic arguments.
  // The compiler can't verify the specific overloads, so we accept the escape hatch here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyFn = (...args: any[]) => any;
  let fromHono!: AnyFn;
  let registerCrud!: AnyFn;
  let defineEndpoints!: AnyFn;
  let OpenAPIHono!: new () => Hono;

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
  const middlewares: MiddlewareHandler[] = [];

  if (guards.length > 0 || ctx.globalGuards.length > 0) {
    const allGuards = [...ctx.globalGuards, ...guards];

    const guardMiddleware: MiddlewareHandler = async (c, next) => {
      const executionContext: ExecutionContext = {
        getType: <T extends string = 'http'>() => 'http' as T,
        getClass: () => controller,
        getHandler: () => 'crud',
        getContext: <T = Context>() => c as T,
        getRequest: () => c.req.raw,
        switchToHttp: (): HttpArgumentsHost => ({
          getRequest: <T = Request>() => c.req.raw as T,
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

    middlewares.push(guardMiddleware);
  }

  // Create OpenAPIHono sub-app with vela's exception handling
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
  });

  // Mount sub-app at controller prefix
  const mountPath = ctx.joinPaths(ctx.globalPrefix, prefix) || '/';
  app.route(mountPath, subApp);
}
