import { STATUS_TO_CODE, toErrorBody } from '@velajs/errors';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Container } from '../container/container';
import type { Token, Type } from '../container/types';
import { HttpException } from '../errors/http-exception';
import { resolveErrorReporter } from '../exceptions/reporter';
import { ComponentManager } from '../pipeline/component.manager';
import { shouldFilterCatch } from '../pipeline/decorators';
import { PipelineRunner } from '../pipeline/pipeline-runner';
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
    moduleId: string,
    allParamMetadata: Map<string | symbol, ParameterMetadata[]>,
  ): (c: Context) => Promise<Response> {
    const paramMetadata = (allParamMetadata.get(route.handlerName) || []).sort(
      (a, b) => a.index - b.index,
    ) as ParamMetadata[];

    // Read param types once at build time for metatype population.
    // Routed via Reflect so the polyfill funnels both src-level and dist-level
    // consumers to the same registry (matters in tests that import from dist).
    const paramTypes = Reflect.getMetadata(
      'design:paramtypes',
      controller.prototype,
      route.handlerName,
    ) as unknown[] | undefined;

    const methodGuards = ComponentManager.getScopedComponents(
      'guard',
      controller,
      route.handlerName,
    );
    const methodPipes = ComponentManager.getScopedComponents('pipe', controller, route.handlerName);
    const methodInterceptors = ComponentManager.getScopedComponents(
      'interceptor',
      controller,
      route.handlerName,
    );
    // Filters: reverse order (handler → controller → global) — closest to handler runs first
    const methodFilters = [
      ...ComponentManager.getScopedComponents('filter', controller, route.handlerName),
    ].reverse();

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

      const executionContext: ExecutionContext = buildExecutionContext(
        c,
        controller,
        route.handlerName,
        moduleId,
      );

      try {
        const instance = requestContainer.resolve(controller, moduleId);

        const method = Reflect.get(instance, route.handlerName);
        if (typeof method !== 'function') {
          throw new Error(`Method ${String(route.handlerName)} not found on controller`);
        }

        // Guards → args + pipes → interceptor chain → handler, via the shared
        // runner. Authentication/authorization therefore rejects before body
        // parsing and validation work, matching Nest's request lifecycle.
        const result = await PipelineRunner.run({
          context: executionContext,
          guards,
          interceptors,
          resolveArgs: () =>
            this.argumentResolver.extract(c, paramMetadata, pipes, requestContainer, paramTypes),
          invoke: async (args) => Reflect.apply(method, instance, args),
        });

        if (redirect) {
          return mapRedirect(c, result, redirect);
        }

        const response = mapResponse(c, result, httpCode);
        applyResponseHeaders(response, responseHeaders);
        return response;
      } catch (error) {
        const reporter = resolveErrorReporter(requestContainer);
        const source = `${controller.name}.${String(route.handlerName)}`;
        // Report FIRST, always — rendering (filters included) is a separate
        // concern; a filter claiming the error must not make it invisible.
        reporter.report(error, { edge: 'http', source });

        for (const filter of filters) {
          if (shouldFilterCatch(filter, error)) {
            try {
              const filtered = await filter.catch(error, executionContext);
              return mapResponse(c, filtered);
            } catch (filterError) {
              // A broken filter is itself a bug worth logs — then fall through
              // to the default render instead of silently dying here.
              reporter.report(filterError, {
                edge: 'http',
                source,
                note: 'exception filter threw',
              });
              break;
            }
          }
        }

        const rendered = reporter.render(error, executionContext);
        if (rendered instanceof Response) return rendered;
        if (rendered) return c.json(rendered.body, rendered.status as ContentfulStatusCode);

        if (error instanceof HttpException) {
          const status = error.getStatus() as ContentfulStatusCode;
          const raw = error.getRawResponse() ?? error.message;
          if (typeof raw === 'string') {
            return c.json(
              { error: { code: STATUS_TO_CODE[status] ?? 'internal', message: raw } },
              status,
            );
          }
          return c.json(raw, status); // object responses ship verbatim (crud envelope compat)
        }

        const { body, status } = toErrorBody(error, { catalog: reporter.catalog });
        return c.json(body, status as ContentfulStatusCode);
      }
    };
  }
}
