import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Container } from '../container/container';
import type { Token, Type } from '../container/types';
import { ForbiddenException, HttpException } from '../errors/http-exception';
import { ComponentManager } from '../pipeline/component.manager';
import { shouldFilterCatch } from '../pipeline/decorators';
import type {
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
  NestInterceptor,
  PipeTransform,
} from '../pipeline/types';
import type {
  FilterType,
  GuardType,
  InterceptorType,
  ParameterMetadata,
  PipeType,
} from '../registry/types';
import type { ArgumentResolver } from './argument-resolver';
import { getHttpCode, getRedirect, getResponseHeaders } from './decorators';
import { buildExecutionContext } from './execution-context';
import { instantiateMany } from './instantiate';
import { applyResponseHeaders, mapRedirect, mapResponse } from './response-mapper';
import type { ParamMetadata, RouteMetadata } from './types';

export interface HandlerGlobals {
  guards: Array<GuardType | Token<CanActivate>>;
  pipes: Array<PipeType | Token<PipeTransform>>;
  interceptors: Array<InterceptorType | Token<NestInterceptor>>;
  filters: Array<FilterType | Token<ExceptionFilter>>;
}

// Builds the per-request closure that runs guards, pipes, interceptors, the
// handler itself, and exception filters. Pure orchestration — Hono route
// registration stays in RouteManager. Globals are read via a callback so
// post-create additions (`useGlobalGuards`, etc.) propagate to subsequent
// requests without rebuilding routes.
export class HandlerExecutor {
  constructor(
    private readonly argumentResolver: ArgumentResolver,
    private readonly getGlobals: () => HandlerGlobals,
    private readonly getRequestContainer: (c: Context) => Container,
  ) {}

  create(
    route: RouteMetadata,
    controller: Type,
    allParamMetadata: Map<string | symbol, ParameterMetadata[]>,
  ): (c: Context) => Promise<Response> {
    const paramMetadata = (allParamMetadata.get(route.handlerName) || [])
      .sort((a, b) => a.index - b.index) as ParamMetadata[];

    // Read param types once at build time for metatype population.
    // Routed via Reflect so the polyfill funnels both src-level and dist-level
    // consumers to the same registry (matters in tests that import from dist).
    const paramTypes = Reflect.getMetadata('design:paramtypes', controller.prototype, route.handlerName) as
      | unknown[]
      | undefined;

    const methodGuards = ComponentManager.getComponents('guard', controller, route.handlerName);
    const methodPipes = ComponentManager.getComponents('pipe', controller, route.handlerName);
    const methodInterceptors = ComponentManager.getComponents('interceptor', controller, route.handlerName);
    // Filters: reverse order (handler → controller → global) — closest to handler runs first
    const methodFilters = [...ComponentManager.getComponents('filter', controller, route.handlerName)].reverse();

    const httpCode = getHttpCode(controller, route.handlerName);
    const responseHeaders = getResponseHeaders(controller, route.handlerName);
    const redirect = getRedirect(controller, route.handlerName);

    return async (c: Context) => {
      // Combine global + method at request time so post-create registrations propagate.
      const requestContainer = this.getRequestContainer(c);
      const globals = this.getGlobals();

      const guards = [
        ...instantiateMany<CanActivate>(globals.guards, requestContainer),
        ...instantiateMany<CanActivate>(methodGuards, requestContainer),
      ];
      const pipes = [
        ...instantiateMany<PipeTransform>(globals.pipes, requestContainer),
        ...instantiateMany<PipeTransform>(methodPipes, requestContainer),
      ];
      const interceptors = [
        ...instantiateMany<NestInterceptor>(globals.interceptors, requestContainer),
        ...instantiateMany<NestInterceptor>(methodInterceptors, requestContainer),
      ];
      const filters = [
        ...instantiateMany<ExceptionFilter>(methodFilters, requestContainer),
        ...instantiateMany<ExceptionFilter>(globals.filters, requestContainer),
      ];

      const executionContext: ExecutionContext = buildExecutionContext(c, controller, route.handlerName);

      try {
        const instance = requestContainer.resolve(controller);

        // 1. Extract args + run pipes (vela order: args before guards).
        const args = await this.argumentResolver.extract(c, paramMetadata, pipes, requestContainer, paramTypes);

        // 2. Guards (fail-fast).
        for (const guard of guards) {
          const canActivate = await guard.canActivate(executionContext);
          if (!canActivate) {
            throw new ForbiddenException();
          }
        }

        // 3. Get handler method.
        const method = Reflect.get(instance, route.handlerName);
        if (typeof method !== 'function') {
          throw new Error(`Method ${String(route.handlerName)} not found on controller`);
        }

        // 4. Build core handler.
        const coreHandler = async () => Reflect.apply(method, instance, args);

        // 5. Run interceptor chain.
        const result = await ComponentManager.runInterceptorChain(
          interceptors,
          executionContext,
          coreHandler,
        );

        if (redirect) {
          return mapRedirect(c, result, redirect);
        }

        const response = mapResponse(c, result, httpCode);
        applyResponseHeaders(response, responseHeaders);
        return response;
      } catch (error) {
        for (const filter of filters) {
          if (shouldFilterCatch(filter, error)) {
            try {
              const filtered = await filter.catch(error, executionContext);
              return mapResponse(c, filtered);
            } catch {
              break;
            }
          }
        }

        if (error instanceof HttpException) {
          const response = error.getResponse();
          const status = error.getStatus() as ContentfulStatusCode;
          return c.json(response, status);
        }

        return c.json({ statusCode: 500, message: 'Internal Server Error' }, 500);
      }
    };
  }
}

