import {
  bindTrustedRequestContext,
  parseSchemaAsync,
  PipelineRunner,
  resolveScopedComponentsAsync,
  resolvePipelineComponents,
  shouldFilterCatch,
  type ExecutionContext,
  type SchemaOutput,
  type Type,
  type ValidationSchema,
} from '@velajs/vela';
import type { GraphQLFieldResolver } from 'graphql';
import { GraphqlOperation } from './operation';
import type { GraphqlContext, GraphqlResolverContext } from './types';

type ResolverMethod<T, Input> = {
  [K in keyof T]-?: T[K] extends (input: Input, context: GraphqlResolverContext) => unknown
    ? K
    : never;
}[keyof T] &
  (string | symbol);
type MethodResult<T, K extends keyof T> = T[K] extends (...args: never[]) => infer R
  ? Awaited<R>
  : never;

export interface GraphqlExecutionContext extends ExecutionContext {
  getType(): 'graphql';
  getGraphql(): GraphqlResolverContext;
  switchToWs(): never;
}

export interface ResolverOptions<
  S extends ValidationSchema,
  Output extends ValidationSchema | undefined = undefined,
> {
  readonly args: S;
  readonly output?: Output;
  /** Exact declaring module from discovery; required when the token has multiple owners. */
  readonly moduleId?: string;
}

/** Bind a real provider method. Arguments are inferred from the validator's OUTPUT. */
export function bindResolver<
  T extends object,
  S extends ValidationSchema,
  K extends ResolverMethod<T, SchemaOutput<S>>,
  Output extends ValidationSchema | undefined = undefined,
>(
  provider: Type<T>,
  methodName: K,
  options: ResolverOptions<S, Output>,
): GraphQLFieldResolver<
  unknown,
  GraphqlContext,
  Record<string, unknown>,
  Promise<Output extends ValidationSchema ? SchemaOutput<Output> : MethodResult<T, K>>
> {
  return async (root, args, context, info) => {
    const operation = context.operation;
    if (!(operation instanceof GraphqlOperation))
      throw new Error('Resolver requires a Vela GraphQL operation');
    const container = operation.container;
    const owners = container.getOwnerModuleIds(provider);
    const moduleId = options.moduleId ?? (owners.length === 1 ? owners[0] : undefined);
    if (!moduleId || !owners.includes(moduleId))
      throw new Error(`GraphQL resolver ${provider.name} needs an unambiguous owner module`);
    const field = Object.freeze({
      operation,
      root,
      info,
      request: operation.request,
      signal: operation.signal,
    });
    const execution = executionContext(operation, provider, methodName, moduleId, field);
    const guards = [
      ...(await resolvePipelineComponents(
        'guard',
        operation.pipeline.guards ?? [],
        container,
        moduleId,
      )),
      ...(await resolveScopedComponentsAsync('guard', provider, methodName, container, moduleId)),
    ];
    const pipes = [
      ...(await resolvePipelineComponents(
        'pipe',
        operation.pipeline.pipes ?? [],
        container,
        moduleId,
      )),
      ...(await resolveScopedComponentsAsync('pipe', provider, methodName, container, moduleId)),
    ];
    const interceptors = [
      ...(await resolvePipelineComponents(
        'interceptor',
        operation.pipeline.interceptors ?? [],
        container,
        moduleId,
      )),
      ...(await resolveScopedComponentsAsync(
        'interceptor',
        provider,
        methodName,
        container,
        moduleId,
      )),
    ];
    const filters = [
      ...(await resolveScopedComponentsAsync('filter', provider, methodName, container, moduleId)),
    ]
      .toReversed()
      .concat(
        await resolvePipelineComponents(
          'filter',
          operation.pipeline.filters ?? [],
          container,
          moduleId,
        ),
      );
    let result: unknown;
    try {
      result = await PipelineRunner.run({
        context: execution,
        guards,
        interceptors,
        resolveArgs: async () => {
          let input: unknown = args;
          for (const pipe of pipes) {
            const metadata = { type: 'graphql' as const, data: info.fieldName };
            input = pipe.transformAsync
              ? await pipe.transformAsync(input, metadata)
              : await pipe.transform(input, metadata);
          }
          // Parse once, after general transforms, so no pipe can invalidate a checked value.
          return [await parseSchemaAsync(options.args, input), field];
        },
        invoke: async (values) => {
          operation.assertActive();
          const instance = await container.resolveAsync(provider, moduleId);
          const method: unknown = Reflect.get(instance, methodName);
          if (typeof method !== 'function')
            throw new TypeError(`GraphQL resolver method ${String(methodName)} is not callable`);
          const value: unknown = await Reflect.apply(method, instance, values);
          operation.assertActive();
          return value;
        },
      });
    } catch (error) {
      let handled = false;
      for (const filter of filters) {
        if (!shouldFilterCatch(filter, error)) continue;
        result = await filter.catch(error, execution);
        if (result instanceof Response)
          throw new TypeError(
            'GraphQL field filters must return field data or throw, not an HTTP Response',
            { cause: error },
          );
        handled = true;
        break;
      }
      if (!handled) throw error;
    }
    operation.assertActive();
    // The reflection boundary erases the method correlation; the public constraint above checks it.
    let output: unknown = result;
    if (options.output) {
      try {
        output = await parseSchemaAsync(options.output, result);
      } catch (cause) {
        throw new Error('Invalid GraphQL resolver output', { cause });
      }
    }
    operation.assertActive();
    return output as Output extends ValidationSchema ? SchemaOutput<Output> : MethodResult<T, K>;
  };
}

function executionContext(
  operation: GraphqlOperation,
  provider: Type,
  method: string | symbol,
  moduleId: string,
  field: GraphqlResolverContext,
): GraphqlExecutionContext {
  const http = operation.http;
  const container = operation.container;
  const execution: GraphqlExecutionContext = {
    getType: () => 'graphql',
    getClass: () => provider,
    getHandler: () => method,
    getModuleId: () => moduleId,
    getContainer: () => container,
    getRequest: () => operation.request,
    getContext: () => http,
    switchToHttp: () => ({ getRequest: () => operation.request, getResponse: () => http }),
    switchToWs: () => {
      throw new Error('GraphQL HTTP fields have no WebSocket host');
    },
    getGraphql: () => field,
  };
  bindTrustedRequestContext(execution, operation.request);
  return Object.freeze(execution);
}
