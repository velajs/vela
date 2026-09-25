/** Lifecycle hooks the application context calls; never RPC methods. */
const LIFECYCLE_HOOKS = new Set([
  'onModuleInit',
  'onApplicationBootstrap',
  'onModuleDestroy',
  'beforeApplicationShutdown',
  'onApplicationShutdown',
]);

/** Durable Object event handlers a host may implement; the object delegates them. */
export const DURABLE_OBJECT_HANDLERS = [
  'fetch',
  'alarm',
  'webSocketMessage',
  'webSocketClose',
  'webSocketError',
] as const;

export type DurableObjectHandlerName = (typeof DURABLE_OBJECT_HANDLERS)[number];

/**
 * Names a host method cannot take: the Durable Object's own `ctx` and `env`,
 * and the stub members `connect()` (a TCP socket) and `dup()`, which shadow
 * any RPC method of that name.
 */
const RESERVED = new Set(['ctx', 'env', 'connect', 'dup']);

function isHandler(name: string): name is DurableObjectHandlerName {
  return (DURABLE_OBJECT_HANDLERS as readonly string[]).includes(name);
}

/** What a host class contributes to its Durable Object class. */
export interface DurableObjectHostMembers {
  /** RPC methods: the host's own and inherited prototype methods. */
  readonly methods: readonly string[];
  /** Event handlers the host implements, in {@link DURABLE_OBJECT_HANDLERS} order. */
  readonly handlers: readonly DurableObjectHandlerName[];
}

/**
 * The public methods of `host`: string-keyed functions on its prototype chain
 * (below `Object.prototype`), the nearest declaration first. Accessors,
 * `#private` members, symbols, the constructor and lifecycle hooks are not
 * RPC methods; `fetch`, `alarm` and the WebSocket handlers become the
 * object's handlers. Read at class definition, without constructing the host.
 */
export function durableObjectHostMembers(host: abstract new (...args: never[]) => unknown): {
  methods: string[];
  handlers: DurableObjectHandlerName[];
} {
  const methods: string[] = [];
  const handlers = new Set<DurableObjectHandlerName>();
  const seen = new Set<string>();
  for (
    let prototype: unknown = host.prototype;
    typeof prototype === 'object' && prototype !== null && prototype !== Object.prototype;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor' || seen.has(name)) continue;
      seen.add(name);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (typeof descriptor?.value !== 'function') continue;
      if (RESERVED.has(name)) {
        throw new TypeError(
          `${host.name}.${name}() cannot be a Durable Object RPC method: '${name}' is reserved ` +
            'by the Durable Object class or its stubs. Rename the method.',
        );
      }
      if (LIFECYCLE_HOOKS.has(name)) continue;
      if (isHandler(name)) handlers.add(name);
      else methods.push(name);
    }
  }
  return {
    methods,
    handlers: DURABLE_OBJECT_HANDLERS.filter((name) => handlers.has(name)),
  };
}
