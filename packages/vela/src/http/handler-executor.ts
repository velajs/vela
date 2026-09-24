import type { Context } from 'hono';
import type { Container } from '../container/container';
import type { TypedToken, Type } from '../container/types';
import { resolveErrorReporter } from '../exceptions/reporter';
import { shouldFilterCatch } from '../pipeline/decorators';
import {
  isSkippableGuardPhase,
  orderGuardsByPhase,
  SKIP_GUARD_PHASES_KEY,
  type GuardPhase,
} from '../pipeline/guard-phase';
import { PipelineRunner } from '../pipeline/pipeline-runner';
import { getScopedComponents } from '../pipeline/scoped-components';
import type {
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
  NestInterceptor,
  PipeTransform,
} from '../pipeline/types';
import { MetadataRegistry } from '../registry/metadata.registry';
import type {
  FilterType,
  GuardType,
  InterceptorType,
  ParameterMetadata,
  PipeType,
} from '../registry/types';
import type { ArgumentResolver } from './argument-resolver';
import { getHttpCode, getRedirect, getResponder, getResponseHeaders } from './decorators';
import { buildExecutionContext } from './execution-context';
import { mapFilterResult, sendHttpError } from './error-response';
import { instantiateAsync, instantiateManyAsync } from './instantiate';
import {
  applyResponseHeaders,
  mapRedirect,
  mapResponse,
  resolveSuccessStatus,
} from './response-mapper';
import { enterRoute, sendRouteResult, type ExecutingRoute } from './route-response';
import type { ParamMetadata, RouteMetadata } from './types';

// The global guard phases an integration's route leaves to the integration
// (`SkipGuardPhases`). Only tenant and authorize phases can be skipped.
function skippedGuardPhases(
  controller: Type,
  handlerName: string | symbol,
): ReadonlySet<GuardPhase> | undefined {
  const declared: unknown =
    MetadataRegistry.getCustomHandlerMeta(controller, handlerName, SKIP_GUARD_PHASES_KEY) ??
    MetadataRegistry.getCustomClassMeta(controller, SKIP_GUARD_PHASES_KEY);
  if (!Array.isArray(declared)) return undefined;
  const phases = new Set<GuardPhase>();
  for (const phase of declared) if (isSkippableGuardPhase(phase)) phases.add(phase);
  return phases.size > 0 ? phases : undefined;
}

export interface HandlerGlobals {
  guards: Array<GuardType | TypedToken<CanActivate>>;
  pipes: Array<PipeType | TypedToken<PipeTransform>>;
  interceptors: Array<InterceptorType | TypedToken<NestInterceptor>>;
  filters: Array<FilterType | TypedToken<ExceptionFilter>>;
}

// Builds the per-request closure that runs guards, pipes, interceptors, the
// handler itself, and exception filters. Pure orchestration — Hono route
// registration stays in RouteManager. Globals are read via a callback so
// post-create additions (`useGlobalGuards`, etc.) propagate to subsequent
// requests without rebuilding routes. Scoped lists (including module-level
// components) are read from the owning application's container at build time.
export class HandlerExecutor {
  readonly #argumentResolver: ArgumentResolver;
  readonly #getGlobals: () => HandlerGlobals;
  readonly #getRequestContainer: (c: Context) => Container;
  readonly #container: Container;

  constructor(
    argumentResolver: ArgumentResolver,
    getGlobals: () => HandlerGlobals,
    getRequestContainer: (c: Context) => Container,
    container: Container,
  ) {
    this.#argumentResolver = argumentResolver;
    this.#getGlobals = getGlobals;
    this.#getRequestContainer = getRequestContainer;
    this.#container = container;
  }

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

    const container = this.#container;
    const methodGuards = getScopedComponents(
      'guard',
      controller,
      route.handlerName,
      container,
      moduleId,
    );
    const methodPipes = getScopedComponents(
      'pipe',
      controller,
      route.handlerName,
      container,
      moduleId,
    );
    const methodInterceptors = getScopedComponents(
      'interceptor',
      controller,
      route.handlerName,
      container,
      moduleId,
    );
    // Filters: reverse order (handler → module → controller → global) — closest to handler runs first
    const methodFilters = getScopedComponents(
      'filter',
      controller,
      route.handlerName,
      container,
      moduleId,
    ).toReversed();

    const source = `${controller.name}.${String(route.handlerName)}`;
    const contract = route.contract;
    const responseHeaders = getResponseHeaders(controller, route.handlerName);
    const redirect = getRedirect(controller, route.handlerName);
    const respond = getResponder(controller, route.handlerName);
    if (contract && (redirect || respond)) {
      throw new Error(
        `${source}: route response options cannot be combined with @Redirect or @Sse; the route declares how it responds`,
      );
    }
    if (getHttpCode(controller, route.handlerName) !== undefined) {
      if (contract?.shared)
        throw new Error(
          `${source}: declare status in the defineRoute contract; its clients are typed with that status, not @HttpCode`,
        );
      if (contract?.status !== undefined)
        throw new Error(
          `${source}: declare the success status once, with @HttpCode or the route's status`,
        );
    }
    const successStatus = resolveSuccessStatus(controller, route);
    const executing: ExecutingRoute = { status: successStatus, contract, source };
    const skippedPhases = skippedGuardPhases(controller, route.handlerName);
    // Each parameter's reader is built once for this route; configuration
    // errors (a form schema with non-text fields, …) surface at startup.
    const extractionRoute = { method: route.method, contract, source };
    const extractors = paramMetadata.map((param) =>
      param.extract?.(extractionRoute, param, param.metatype ?? paramTypes?.[param.index]),
    );

    return async (c: Context) => {
      // Combine global + method at request time so post-create registrations propagate.
      const requestContainer = this.#getRequestContainer(c);
      const globals = this.#getGlobals();

      enterRoute(c, executing);
      const executionContext: ExecutionContext = buildExecutionContext(
        c,
        controller,
        route.handlerName,
        moduleId,
      );

      try {
        const guards = [
          ...orderGuardsByPhase(
            await instantiateManyAsync<CanActivate>(globals.guards, requestContainer),
            skippedPhases,
          ),
          ...(await instantiateManyAsync<CanActivate>(methodGuards, requestContainer, moduleId)),
        ];
        const pipes = [
          ...(await instantiateManyAsync<PipeTransform>(globals.pipes, requestContainer)),
          ...(await instantiateManyAsync<PipeTransform>(methodPipes, requestContainer, moduleId)),
        ];
        const interceptors = [
          ...(await instantiateManyAsync<NestInterceptor>(globals.interceptors, requestContainer)),
          ...(await instantiateManyAsync<NestInterceptor>(
            methodInterceptors,
            requestContainer,
            moduleId,
          )),
        ];
        // Guards → args + pipes → interceptor chain → handler, via the shared
        // runner. Authentication/authorization therefore rejects before body
        // parsing and validation work, matching Nest's request lifecycle.
        const result = await PipelineRunner.run({
          context: executionContext,
          guards,
          interceptors,
          resolveArgs: () =>
            this.#argumentResolver.extract(
              c,
              paramMetadata,
              pipes,
              requestContainer,
              paramTypes,
              moduleId,
              extractors,
            ),
          invoke: async (args) => {
            // Singleton lifecycle is owned by bootstrap. Request-scoped
            // controllers need not exist when a guard/pipe/interceptor rejects.
            const instance = await requestContainer.resolveAsync(controller, moduleId);
            if (
              (typeof instance !== 'object' || instance === null) &&
              typeof instance !== 'function'
            ) {
              throw new Error(`Controller ${controller.name} did not resolve to an object`);
            }

            const method: unknown = Reflect.get(instance, route.handlerName);
            if (typeof method !== 'function') {
              throw new Error(`Method ${String(route.handlerName)} not found on controller`);
            }
            return Reflect.apply(method, instance, args);
          },
        });

        if (redirect) {
          return mapRedirect(c, result, redirect);
        }

        const response = contract
          ? await sendRouteResult(c, contract, successStatus, result, source)
          : respond
            ? respond(c, result, (error) => {
                resolveErrorReporter(requestContainer).report(error, {
                  edge: 'http',
                  source,
                  note: 'response stream failed',
                });
              })
            : mapResponse(c, result, successStatus);
        applyResponseHeaders(response, responseHeaders);
        return response;
      } catch (error) {
        const reporter = resolveErrorReporter(requestContainer);
        // Report FIRST, always — rendering (filters included) is a separate
        // concern; a filter claiming the error must not make it invisible.
        reporter.report(error, { edge: 'http', source });

        // Resolve filters only on failure. Construction itself belongs to
        // this boundary; a broken filter must not hide the original error.
        const filterEntries = [
          ...methodFilters.map((entry) => ({ entry, owner: moduleId })),
          ...globals.filters.map((entry) => ({ entry, owner: undefined })),
        ];
        for (const { entry, owner } of filterEntries) {
          try {
            const filter = await instantiateAsync<ExceptionFilter>(entry, requestContainer, owner);
            if (shouldFilterCatch(filter, error)) {
              // The first matching filter decides; `undefined` leaves the
              // error to the default renderer.
              const filtered = mapFilterResult(
                c,
                await filter.catch(error, executionContext),
                error,
              );
              if (filtered) return filtered;
              break;
            }
          } catch (filterError) {
            reporter.report(filterError, {
              edge: 'http',
              source,
              note: 'exception filter construction or execution threw',
            });
            break;
          }
        }

        return sendHttpError(c, error, reporter, executionContext);
      }
    };
  }
}
