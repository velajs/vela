import type { LiveQueryDefinition } from '@velajs/live-protocol';
import { createDiscoverableDecorator } from '../discovery/discoverable.decorator';
import { LIVE_RESOLVER_METADATA } from './live.tokens';
import type {
  LiveQueryContext,
  LiveQueryMetadata,
  LiveQueryOptions,
  LiveResolverMetadata,
} from './live.types';

const LiveResolverMeta = createDiscoverableDecorator<LiveResolverMetadata>(LIVE_RESOLVER_METADATA);
const declarations = new WeakMap<object, LiveQueryMetadata[]>();

/**
 * Marks a provider class as a live-query resolver:
 *
 * ```ts
 * @LiveResolver()
 * class TodoLive {
 *   constructor(private readonly todos: TodoService) {}
 *
 *   @LiveQuery('todos.list', todoListDefinition, { tags: (args) => [`todos:${args.listId}`] })
 *   list(args: { listId: string }, ctx: LiveQueryContext) {
 *     return this.todos.byList(args.listId, ctx.identity?.userId);
 *   }
 * }
 * ```
 *
 * Clients subscribe by query name over the `$live` reserved event; the engine
 * re-runs a handler whenever one of its tags is invalidated and pushes the
 * result (as a keyed delta when possible). Like any Vela class decorator it
 * implies `@Injectable()`; stack `@Injectable({ scope })` only to set a scope.
 */
export function LiveResolver(): ClassDecorator {
  return LiveResolverMeta({});
}

/**
 * Declares a live query on a resolver method. The handler receives
 * `(args, ctx: LiveQueryContext)` positionally. The portable definition parses
 * args once at subscribe/restore and validates the final result after all
 * interceptors. Bound closures preserve the parsed type across erased metadata.
 */
export function LiveQuery<Args, Result>(
  name: string,
  definition: LiveQueryDefinition<Args, Result>,
  options: LiveQueryOptions<NoInfer<Args>>,
): <Handler extends (args: Args, context: LiveQueryContext) => Result | Promise<Result>>(
  target: object,
  propertyKey: string | symbol,
  descriptor: TypedPropertyDescriptor<Handler>,
) => void {
  return (target, propertyKey, descriptor) => {
    const handler = descriptor.value;
    if (!handler) throw new TypeError('@LiveQuery can only decorate a method.');
    const ctor = target.constructor;
    const coalesceBy = options.coalesceBy;
    const metadata: LiveQueryMetadata = {
      name,
      methodName: propertyKey,
      definition,
      ...(options.key === undefined ? {} : { key: options.key }),
      prepare(input) {
        const args = definition.args.parse(input);
        return {
          input,
          args,
          tags: () => (typeof options.tags === 'function' ? options.tags(args) : options.tags),
          ...(coalesceBy === undefined
            ? {}
            : {
                coalesceBy: (context: LiveQueryContext) => coalesceBy(args, context),
              }),
          invoke: (instance, context) => handler.call(instance, args, context),
        };
      },
    };
    declarations.set(ctor, [...getLiveQueries(ctor), metadata]);
  };
}

/** `@LiveQuery` entries declared on a resolver class (declaration order). */
export function getLiveQueries(resolverClass: object): LiveQueryMetadata[] {
  for (
    let current: object | null = resolverClass;
    current !== null;
    current = Reflect.getPrototypeOf(current)
  ) {
    const own = declarations.get(current);
    if (own) return [...own];
  }
  return [];
}
