import type { ExecutionContext } from '../pipeline/types';
import { createParamDecorator } from './decorators';

/**
 * Injects a memoized function. Calling it explicitly runs the factory once;
 * later calls return the same value or Promise, or rethrow the same error.
 * A factory may return a primitive, object, undefined, null or Promise.
 *
 * Guards run before argument extraction for both ordinary and lazy parameter
 * decorators. Use this variant only to defer work that a handler may not need.
 * Apply validation to the factory result rather than attaching parameter pipes
 * to the injected function.
 *
 * @example
 * ```ts
 * const DeferredProfile = createLazyParamDecorator(
 *   (_data: undefined, ctx: ExecutionContext) => loadProfile(ctx.getRequest()),
 * );
 *
 * @Get('/me')
 * async me(@DeferredProfile() load: () => Promise<User | undefined>) {
 *   const user = await load();
 *   return { id: user?.id };
 * }
 * ```
 */
export function createLazyParamDecorator<TData = unknown>(
  factory: (data: TData, ctx: ExecutionContext) => unknown,
): (...args: undefined extends TData ? [data?: TData] : [data: TData]) => ParameterDecorator;
export function createLazyParamDecorator<TData>(
  factory: (data: TData, ctx: ExecutionContext) => unknown,
): (data: TData) => ParameterDecorator {
  const decorator = createParamDecorator((data: TData, ctx) => memoize(() => factory(data, ctx)));
  return (data: TData) => decorator(data);
}

type LazyState<T> =
  | { status: 'pending' }
  | { status: 'resolved'; value: T }
  | { status: 'rejected'; error: unknown };

function memoize<T>(produce: () => T): () => T {
  let state: LazyState<T> = { status: 'pending' };
  return () => {
    if (state.status === 'resolved') return state.value;
    if (state.status === 'rejected') throw state.error;
    try {
      const value = produce();
      state = { status: 'resolved', value };
      return value;
    } catch (error) {
      state = { status: 'rejected', error };
      throw error;
    }
  };
}
