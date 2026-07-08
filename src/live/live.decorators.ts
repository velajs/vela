import { createDiscoverableDecorator, defineMetadata, getMetadata } from '../index';
import { LIVE_QUERY_METADATA, LIVE_RESOLVER_METADATA } from './live.tokens';
import type { LiveQueryMetadata, LiveQueryOptions, LiveResolverMetadata } from './live.types';

const LiveResolverMeta = createDiscoverableDecorator<LiveResolverMetadata>(LIVE_RESOLVER_METADATA);

/**
 * Marks a provider class as a live-query resolver:
 *
 * ```ts
 * @LiveResolver()
 * @Injectable()
 * class TodoLive {
 *   constructor(private readonly todos: TodoService) {}
 *
 *   @LiveQuery('todos.list', { tags: (a: { listId: string }) => [`todos:${a.listId}`] })
 *   list(args: { listId: string }, ctx: LiveQueryContext) {
 *     return this.todos.byList(args.listId, ctx.identity?.userId);
 *   }
 * }
 * ```
 *
 * Clients subscribe by query name over the `$live` reserved event; the engine
 * re-runs a handler whenever one of its tags is invalidated and pushes the
 * result (as a keyed delta when possible). Stack with `@Injectable()`, exactly
 * like `@Processor`.
 */
export function LiveResolver(): ClassDecorator {
  return LiveResolverMeta({}) as ClassDecorator;
}

/**
 * Declares a live query on a resolver method. The handler receives
 * `(args, ctx: LiveQueryContext)` positionally — args are validated once at
 * subscribe (via `options.parse`), then replayed verbatim into every re-run
 * under the subscriber's captured identity.
 */
export function LiveQuery<A = unknown>(name: string, options: LiveQueryOptions<A>): MethodDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const ctor = target.constructor;
    const existing = (getMetadata(LIVE_QUERY_METADATA, ctor) as LiveQueryMetadata[] | undefined) ?? [];
    existing.push({ name, methodName: propertyKey, options: options as LiveQueryOptions });
    defineMetadata(LIVE_QUERY_METADATA, existing, ctor);
  };
}

/** `@LiveQuery` entries declared on a resolver class (declaration order). */
export function getLiveQueries(resolverClass: object): LiveQueryMetadata[] {
  return (getMetadata(LIVE_QUERY_METADATA, resolverClass) as LiveQueryMetadata[] | undefined) ?? [];
}
