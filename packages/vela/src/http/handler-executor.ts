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
import {
  inheritedClassMeta,
  inheritedHandlerMeta,
  inheritedParameters,
  inheritedParamTypes,
} from '../registry/inherited-metadata';
import type { FilterType, GuardType, InterceptorType, PipeType } from '../registry/types';
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
import { readJsonBody } from './json-body';
import { routeInputReader } from './route-input-registry';
import {
  enterRoute,
  replayedResponse,
  responseSent,
  sendRouteResult,
  type ExecutingRoute,
} from './route-response';
import type { ParamExtractionRoute, ParamMetadata, RouteMetadata } from './types';

// The global guard phases an integration's route leaves to the integration
// (`SkipGuardPhases`). Only tenant and authorize phases can be skipped.
function skippedGuardPhases(
  controller: Type,
  handlerName: string | symbol,
): ReadonlySet<GuardPhase> | undefined {
  // Read as the Reflector reads it: inherited method, then class, declarations.
  const declared: unknown =
    inheritedHandlerMeta(controller, handlerName, SKIP_GUARD_PHASES_KEY) ??
    inheritedClassMeta(controller, SKIP_GUARD_PHASES_KEY);
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
    /** The paths the route serves, for checks of its declared path parameters. */
    paths: readonly string[] = [],
  ): (c: Context) => Promise<Response> {
    // A method the controller inherits unchanged reads its ancestor's parameters.
    const paramMetadata = inheritedParameters(controller, route.handlerName).toSorted(
      (a, b) => a.index - b.index,
    ) as ParamMetadata[];

    // Read param types once at build time for metatype population, from the
    // class that declares the method, an ancestor's for an inherited one.
    const paramTypes = inheritedParamTypes(controller, route.handlerName);

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
    // Options that declare only the request leave the response to @Redirect
    // or @Sse; a shared contract types its clients with its own response.
    if (
      contract &&
      (redirect || respond) &&
      (contract.shared ||
        contract.response !== undefined ||
        contract.status !== undefined ||
        contract.format !== undefined)
    ) {
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
    // What the route declares is enforced once per request, after guards,
    // whether or not a parameter reads it: its request schemas and its body.
    const base: ParamExtractionRoute = { method: route.method, contract, source, paths };
    const body = contract?.body;
    // The reader `@Body`, `@Query` and `@Param` install checks request schemas
    // and bodies; a bundler drops it from a Worker that uses none of them.
    // Without it, no parameter reads a body: a JSON body is read here.
    const schemas = contract?.params || contract?.query || contract?.bodySchema;
    const input = schemas || body ? routeInputReader()?.(base) : undefined;
    if (!input && (schemas || (body && body.kind !== 'json')))
      throw new Error(
        `${source}: validating its declared request needs the reader @Body, @Query and @Param install, and none of them is in this bundle; read the declared input with one of them`,
      );
    // Each parameter's reader is built once for this route; configuration
    // errors (a form schema with non-text fields, …) surface at startup.
    const extractionRoute = input ? { ...base, input } : base;
    const extractors = paramMetadata.map((param) =>
      param.extract?.(extractionRoute, param, param.metatype ?? paramTypes?.[param.index]),
    );
    // A result the route serializes as JSON or text, which a response cache
    // may store.
    const format = contract?.format;
    const serialized =
      !redirect && !respond && (format === undefined || format === 'json' || format === 'text');

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
          resolveArgs: async () => {
            if (input) await input(c);
            else if (body) await readJsonBody(c, { maxBytes: body.maxBytes });
            return this.#argumentResolver.extract(
              c,
              paramMetadata,
              pipes,
              requestContainer,
              paramTypes,
              moduleId,
              extractors,
            );
          },
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

        // A replayed response is sent as is, whatever interceptors outside
        // the one replaying it returned instead of a Response.
        const replay = result instanceof Response ? undefined : replayedResponse(c);
        const response =
          replay ??
          (respond
            ? respond(c, result, (error) => {
                resolveErrorReporter(requestContainer).report(error, {
                  edge: 'http',
                  source,
                  note: 'response stream failed',
                });
              })
            : contract
              ? await sendRouteResult(c, contract, successStatus, result, source)
              : mapResponse(c, result, successStatus));
        applyResponseHeaders(response, responseHeaders);
        if (serialized && !replay && !(result instanceof Response)) await responseSent(c, response);
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
