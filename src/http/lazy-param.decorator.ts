import { ParamType } from '../constants';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor, PipeType, Type } from '../registry/types';
import type { ExecutionContext } from '../pipeline/types';
import { buildExecutionContext } from './execution-context';

const CUSTOM_PARAM_TYPE = 'custom';

/**
 * Factory for parameter decorators whose value materializes lazily — the
 * factory does not run during argument extraction; it runs the first time
 * the handler reads a property on the resolved value.
 *
 * Why this exists: vela's argument resolver runs *before* guards
 * (handler-executor order: extract args → guards → handler). A custom
 * `createParamDecorator` factory that depends on guard-populated state
 * (e.g. a value a guard places into `REQUEST_CONTEXT`) therefore observes
 * an empty slot. `createLazyParamDecorator` defers factory execution to
 * first property access on the proxied result, by which point guards have
 * run and the slot is populated.
 *
 * The proxy explicitly short-circuits `prop === 'then'` so `await value`
 * does not consider the proxy a thenable, which would otherwise trigger
 * eager resolution. This single invariant is what makes the helper safe to
 * pass through `async` boundaries without surprise.
 *
 * @example
 * ```ts
 * const CurrentUser = createLazyParamDecorator(
 *   (_data: unknown, ctx: ExecutionContext) => {
 *     const reqCtx = ctx.getContext().get('container').resolve(REQUEST_CONTEXT);
 *     return reqCtx.get('user');     // populated by AuthGuard
 *   },
 * );
 *
 * @UseGuards(AuthGuard)
 * @Get('/me')
 * me(@CurrentUser() user: User) {
 *   return { id: user.id };          // factory runs here, after AuthGuard
 * }
 * ```
 */
export function createLazyParamDecorator<TData = unknown>(
  factory: (data: TData, ctx: ExecutionContext) => unknown,
): (data?: TData, ...pipes: PipeType[]) => ParameterDecorator {
  return (data?: TData, ...pipes: PipeType[]): ParameterDecorator => {
    return (target: object, propertyKey: string | symbol | undefined, parameterIndex: number) => {
      if (propertyKey === undefined) {
        throw new Error('Parameter decorators can only be used on method parameters');
      }

      MetadataRegistry.addParameter(target.constructor as Constructor, propertyKey, {
        index: parameterIndex,
        type: CUSTOM_PARAM_TYPE,
        name: undefined,
        factory: (_unused: unknown, ctx: unknown) => {
          const honoCtx = ctx as import('hono').Context;
          const execCtx = buildExecutionContext(honoCtx, target.constructor as Type, propertyKey);
          return createLazyProxy(() => factory(data as TData, execCtx));
        },
        ...(pipes.length > 0 ? { pipes } : {}),
      });
    };
  };
}

// Single-shot resolution: the factory runs at most once; subsequent reads
// share the cached real value. The proxy's traps all funnel through
// `materialize` to keep that invariant in one place.
function createLazyProxy<T>(produce: () => T): T {
  let resolved = false;
  let value: unknown;

  const materialize = (): unknown => {
    if (!resolved) {
      value = produce();
      resolved = true;
    }
    return value;
  };

  // Target is an empty null-prototype object — proxies still need a
  // backing target for the runtime to forward to, but using a real object
  // would leak its own properties (`hasOwnProperty`, etc.) into trap
  // results. `Object.create(null)` keeps the namespace clean.
  const target = Object.create(null) as object;

  const handler: ProxyHandler<object> = {
    get(_t, prop, receiver) {
      // Critical: do NOT report the proxy as thenable. If we let the JS
      // runtime read `then` (during `await proxy`), the engine would
      // observe a function-shaped value, treat the proxy as a promise,
      // call `then(resolve, reject)` and trigger eager resolution before
      // the consumer ever touches a real property. Returning `undefined`
      // here makes `await proxy` return the proxy itself, untouched.
      if (prop === 'then') return undefined;

      const real = materialize();
      if (real === null || real === undefined) return undefined;

      const descriptor = Reflect.get(real as object, prop, receiver);
      // Bind functions back to the real target so `this` works as the
      // consumer expects on instance methods.
      if (typeof descriptor === 'function') {
        return descriptor.bind(real);
      }
      return descriptor;
    },

    has(_t, prop) {
      const real = materialize();
      return real !== null && real !== undefined && Reflect.has(real as object, prop);
    },

    ownKeys() {
      const real = materialize();
      if (real === null || real === undefined) return [];
      return Reflect.ownKeys(real as object);
    },

    getOwnPropertyDescriptor(_t, prop) {
      const real = materialize();
      if (real === null || real === undefined) return undefined;
      const descriptor = Reflect.getOwnPropertyDescriptor(real as object, prop);
      // Proxy invariants require returned descriptors to be configurable
      // when the underlying target lacks the property, which is always
      // true for our null-prototype empty target.
      if (descriptor) descriptor.configurable = true;
      return descriptor;
    },
  };

  return new Proxy(target, handler) as T;
}
