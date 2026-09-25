import { DurableObject } from 'cloudflare:workers';
import type { Type, VelaEnv } from '@velajs/vela';
import {
  CLOUDFLARE_DURABLE_OBJECT,
  registerDurableObject,
  type CloudflareDurableObjectDescriptor,
} from '../cloudflare-factory';
import { durableObjectDefinition, startDurableObject, type DurableObjectRoot } from './boot';
import { DurableObjectError } from './durable-object-error';
import { createDurableObjectHost, type DurableObjectHostDispatcher } from './host-dispatch';
import { durableObjectHostMembers, type DurableObjectHandlerName } from './host-methods';

/**
 * Host members that are never RPC methods: lifecycle, disposal and entrypoint
 * hooks the application context calls, the object's event handlers, and the
 * names the Durable Object class or its stubs own (`ctx`, `env`, `connect`,
 * `dup`, `id`, `name`).
 */
type NotRpcMethod =
  | 'onModuleInit'
  | 'onApplicationBootstrap'
  | 'onModuleDestroy'
  | 'beforeApplicationShutdown'
  | 'onApplicationShutdown'
  | 'dispose'
  | 'collectEntrypoints'
  | DurableObjectHandlerName
  | 'ctx'
  | 'env'
  | 'connect'
  | 'dup'
  | 'id'
  | 'name';

/**
 * The names a host's `rpc` list may take: its public methods, less hooks,
 * event handlers and names the Durable Object or its stubs own. TypeScript
 * `private` and `protected` methods are not among them.
 */
export type DurableObjectRpcMethod<Host> = {
  [K in keyof Host]: K extends string
    ? K extends NotRpcMethod
      ? never
      : Host[K] extends (...args: never[]) => unknown
        ? K
        : never
    : never;
}[keyof Host];

/**
 * The RPC methods a `VelaDurableObject(root, Host, { rpc })` class exposes:
 * the host methods `Method` names, asynchronous. A stub of the class
 * (`env.COUNTER.getByName(name)`) calls them with these signatures.
 */
export type DurableObjectRpc<Host, Method extends DurableObjectRpcMethod<Host>> = {
  [K in Method]: Host[K] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Promise<Awaited<Result>>
    : never;
};

/** Options of {@link VelaDurableObject}. */
export interface VelaDurableObjectOptions<Method extends string = string> {
  /**
   * The host methods callers may invoke over JS-RPC, such as
   * `['increment', 'reset']`: public methods declared in the host's class
   * body (or inherited). Nothing else is an RPC method, so TypeScript
   * `private` helpers, hooks and unlisted methods stay unreachable. Without
   * it the object serves only its event handlers.
   */
  readonly rpc?: readonly Method[];
}

/**
 * The class `VelaDurableObject(root, Host, { rpc })` returns: export a named
 * subclass of it. It also carries its `CloudflareDurableObjectDescriptor`
 * under the static `CLOUDFLARE_DURABLE_OBJECT` key, for tools.
 */
export type VelaDurableObjectClass<
  Host,
  Method extends DurableObjectRpcMethod<Host> = never,
> = new (
  ctx: DurableObjectState,
  env: VelaEnv,
) => DurableObject<VelaEnv> & DurableObjectRpc<Host, Method>;

/** The dispatcher each instance boots, readable by the methods defined outside the class body. */
const dispatchers = new WeakMap<object, Promise<DurableObjectHostDispatcher>>();

function dispatcherOf(instance: object): Promise<DurableObjectHostDispatcher> {
  const dispatcher = dispatchers.get(instance);
  if (!dispatcher) throw new TypeError('Durable Object method called on a foreign receiver.');
  return dispatcher;
}

/** An RPC caller learns that the object failed to start, never why. */
async function startedDispatcher(instance: object): Promise<DurableObjectHostDispatcher> {
  try {
    return await dispatcherOf(instance);
  } catch {
    throw new DurableObjectError({
      status: 500,
      code: 'internal',
      message: 'Internal Server Error',
    });
  }
}

/**
 * A Durable Object class whose instances each boot one application context
 * from `root` (a module class, a `DynamicModule`, or an app from
 * `defineCloudflareApp`, whose runtime adapters it shares), with `host`, an
 * `@Injectable()` class, added to the root module's providers. Export a named
 * subclass matching the Wrangler `class_name`:
 *
 * ```ts
 * @Injectable()
 * export class CounterHost {
 *   constructor(@Inject(DO_STORAGE) private readonly storage: DurableObjectStorage) {}
 *   async increment(by: number): Promise<number> {
 *     const value = ((await this.storage.get<number>('value')) ?? 0) + by;
 *     await this.storage.put('value', value);
 *     return value;
 *   }
 * }
 * export class Counter extends VelaDurableObject(app, CounterHost, { rpc: ['increment'] }) {}
 * // In the Worker: await env.COUNTER.getByName('orders').increment(1)
 * ```
 *
 * - The host methods the `rpc` option names are the class's JS-RPC methods,
 *   typed so `DurableObjectNamespace<Counter>` stubs expose exactly their
 *   signatures. No other method is reachable over RPC: not an unlisted public
 *   method, a TypeScript `private` helper or a hook. A listed name that is not
 *   a prototype method of the host throws here. `fetch`, `alarm`,
 *   `webSocketMessage`, `webSocketClose` and `webSocketError`, when the host
 *   defines them, become the object's handlers.
 * - The context boots in the constructor under `blockConcurrencyWhile`, so no
 *   event runs before it is ready. It injects `ENV` (the object's
 *   environment), `DO_STATE`, `DO_STORAGE` and `DO_ID`, and reaches WebSocket
 *   rooms and live invalidation as the Worker does.
 * - Each call and event runs in its own execution scope through the host's
 *   scoped guards, pipes, interceptors and filters (`getType()` is `rpc`, or
 *   `cf:do:fetch`, `cf:do:alarm`, `cf:do:websocket`). Failures are reported;
 *   an RPC call rejects with a {@link DurableObjectError} and nothing else.
 */
export function VelaDurableObject<
  Host extends object,
  const Method extends DurableObjectRpcMethod<Host> = never,
>(
  root: DurableObjectRoot,
  host: Type<Host>,
  options: VelaDurableObjectOptions<Method> = {},
): VelaDurableObjectClass<Host, Method> {
  const definition = durableObjectDefinition(root);
  const members = durableObjectHostMembers(host, options.rpc);

  class VelaHostDurableObject extends DurableObject<VelaEnv> {
    constructor(ctx: DurableObjectState, env: VelaEnv) {
      super(ctx, env);
      dispatchers.set(
        this,
        startDurableObject(ctx, host.name, () =>
          createDurableObjectHost(
            definition.rootModule,
            host,
            { env, state: ctx, adapters: definition.adapters },
            members,
          ),
        ),
      );
    }
  }

  const prototype = VelaHostDurableObject.prototype;
  const define = (name: string, value: (this: object, ...args: never[]) => unknown): void => {
    Object.defineProperty(prototype, name, { value, writable: true, configurable: true });
  };
  for (const method of members.methods) {
    define(method, async function (this: object, ...args: unknown[]) {
      return (await startedDispatcher(this)).call(method, args);
    });
  }
  for (const handler of members.handlers) {
    if (handler === 'fetch') {
      define('fetch', async function (this: object, request: Request) {
        let dispatcher: DurableObjectHostDispatcher;
        try {
          dispatcher = await dispatcherOf(this);
        } catch {
          return Response.json(
            { error: { code: 'internal', message: 'Internal Server Error' } },
            { status: 500 },
          );
        }
        return dispatcher.fetch(request);
      });
    } else if (handler === 'alarm') {
      define('alarm', async function (this: object, info?: AlarmInvocationInfo) {
        return (await dispatcherOf(this)).alarm(info);
      });
    } else {
      define(handler, async function (this: object, ...args: unknown[]) {
        return (await dispatcherOf(this)).webSocket(handler, args);
      });
    }
  }

  const descriptor: CloudflareDurableObjectDescriptor = {
    kind: 'host',
    rootModule: definition.rootModule,
    host,
    methods: members.methods,
    durableObject: VelaHostDurableObject,
  };
  Object.defineProperty(VelaHostDurableObject, 'name', { value: `${host.name}DurableObject` });
  if (definition.app) registerDurableObject(definition.app, descriptor);
  Object.defineProperty(VelaHostDurableObject, CLOUDFLARE_DURABLE_OBJECT, { value: descriptor });
  // The RPC methods are defined on the prototype above, at runtime, from the rpc list.
  return VelaHostDurableObject as unknown as VelaDurableObjectClass<Host, Method>;
}
