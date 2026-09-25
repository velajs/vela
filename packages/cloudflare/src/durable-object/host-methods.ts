/**
 * Methods the application context calls on providers: lifecycle hooks, the
 * container's `dispose()` disposal hook and the entrypoint contributor hook.
 * Never RPC methods.
 */
const HOOKS = new Set([
  'constructor',
  'onModuleInit',
  'onApplicationBootstrap',
  'onModuleDestroy',
  'beforeApplicationShutdown',
  'onApplicationShutdown',
  'dispose',
  'collectEntrypoints',
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
 * Names an RPC method cannot take: the Durable Object's own `ctx` and `env`,
 * and the stub members that shadow any RPC method of that name: `connect()`
 * (a TCP socket), `dup()`, and the `id` and `name` properties.
 */
const RESERVED = new Set(['ctx', 'env', 'connect', 'dup', 'id', 'name']);

function isHandler(name: string): name is DurableObjectHandlerName {
  return (DURABLE_OBJECT_HANDLERS as readonly string[]).includes(name);
}

/** What a host class contributes to its Durable Object class. */
export interface DurableObjectHostMembers {
  /** RPC methods: the host methods its `rpc` list names. */
  readonly methods: readonly string[];
  /** Event handlers the host implements, in {@link DURABLE_OBJECT_HANDLERS} order. */
  readonly handlers: readonly DurableObjectHandlerName[];
}

type HostClass = abstract new (...args: never[]) => unknown;

/** The nearest declaration of `name` on the prototype chain of `host`, below `Object.prototype`. */
function prototypeMember(host: HostClass, name: string): PropertyDescriptor | undefined {
  for (
    let prototype: unknown = host.prototype;
    typeof prototype === 'object' && prototype !== null && prototype !== Object.prototype;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor) return descriptor;
  }
  return undefined;
}

/** Why `name` cannot be an RPC method of `host`, or undefined when it can. */
function rpcNameProblem(host: HostClass, name: unknown): string | undefined {
  if (typeof name !== 'string') {
    return `${host.name}: an rpc entry must be a method name, not ${String(name)}.`;
  }
  if (RESERVED.has(name)) {
    return (
      `${host.name}.${name}() cannot be a Durable Object RPC method: '${name}' is reserved ` +
      'by the Durable Object class or its stubs. Rename the method.'
    );
  }
  if (HOOKS.has(name)) {
    return (
      `${host.name}.${name}() cannot be a Durable Object RPC method: the application ` +
      'context calls it (a lifecycle, disposal or entrypoint hook).'
    );
  }
  if (isHandler(name)) {
    return (
      `${host.name}.${name}() is the Durable Object ${name} handler, which the platform ` +
      'calls: leave it out of the rpc list.'
    );
  }
  if (typeof prototypeMember(host, name)?.value !== 'function') {
    return (
      `${host.name} has no prototype method ${name}(): list methods declared in the class ` +
      'body, not accessors or instance fields such as arrow functions.'
    );
  }
  return undefined;
}

/**
 * The members of `host` its Durable Object class exposes: the RPC methods
 * `rpc` names, and the event handlers it implements. Each `rpc` entry must
 * name a string-keyed method on the host's prototype chain (below
 * `Object.prototype`); a hook, an event handler, a name the Durable Object or
 * its stubs own, an accessor or an instance field throws. Nothing else is an
 * RPC method, TypeScript `private` and `protected` methods included. `fetch`,
 * `alarm` and the WebSocket handlers, when the host defines them, become the
 * object's handlers. Read at class definition, without constructing the host.
 */
export function durableObjectHostMembers(
  host: HostClass,
  rpc: readonly string[] = [],
): {
  methods: string[];
  handlers: DurableObjectHandlerName[];
} {
  if (!Array.isArray(rpc)) {
    throw new TypeError(`${host.name}: the rpc option must be an array of method names.`);
  }
  const methods: string[] = [];
  for (const name of rpc) {
    const problem = rpcNameProblem(host, name);
    if (problem !== undefined) throw new TypeError(problem);
    if (!methods.includes(name)) methods.push(name);
  }
  return {
    methods,
    handlers: DURABLE_OBJECT_HANDLERS.filter(
      (name) => typeof prototypeMember(host, name)?.value === 'function',
    ),
  };
}
