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

/** Host members the application context calls, which are never RPC methods. */
export type HostHookName =
  | 'onModuleInit'
  | 'onApplicationBootstrap'
  | 'onModuleDestroy'
  | 'beforeApplicationShutdown'
  | 'onApplicationShutdown'
  | 'dispose'
  | 'collectEntrypoints';

/**
 * The names a host's `rpc` list may take: its public methods, less the
 * `Excluded` names. TypeScript `private` and `protected` methods are not
 * among them.
 */
export type RpcMethodOf<Host, Excluded extends string> = {
  [K in keyof Host]: K extends string
    ? K extends Excluded | HostHookName
      ? never
      : Host[K] extends (...args: never[]) => unknown
        ? K
        : never
    : never;
}[keyof Host];

/** The RPC methods `Method` of `Host`, asynchronous, as the entrypoint's stubs call them. */
export type RpcMethods<Host, Method extends keyof Host> = {
  [K in Method]: Host[K] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Promise<Awaited<Result>>
    : never;
};

/** @internal A class whose prototype methods a host exposes. */
export type HostClass = abstract new (...args: never[]) => unknown;

/** The nearest declaration of `name` on the prototype chain of `host`, below `Object.prototype`. */
export function prototypeMember(host: HostClass, name: string): PropertyDescriptor | undefined {
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

/** Whether `host` declares the prototype method `name` (not an accessor or an instance field). */
export function hasPrototypeMethod(host: HostClass, name: string): boolean {
  return typeof prototypeMember(host, name)?.value === 'function';
}

/**
 * Reject a host whose prototype chain defines `then`, as a method or an
 * accessor: an instance would be a thenable, so awaiting the resolved host
 * would call it instead of producing the instance, and the invocation would
 * hang. Checked when the class is defined, without constructing the host.
 */
export function assertNotThenable(host: HostClass): void {
  if (prototypeMember(host, 'then') === undefined) return;
  throw new TypeError(
    `${host.name} defines then(), which makes every instance a thenable: resolving the host ` +
      'would call it instead of returning the instance, and each invocation would hang. ' +
      'Rename the method.',
  );
}

/** How one kind of host names its RPC restrictions in messages. */
export interface RpcSurface<Handler extends string> {
  /** What the class is, as messages name it: `'Durable Object'`, `'service entrypoint'`. */
  readonly label: string;
  /** Names the class or its stubs own, which no RPC method may take. */
  readonly reserved: ReadonlySet<string>;
  /** Event handlers the platform calls on the class, in the order the class defines them. */
  readonly handlers: readonly Handler[];
}

/** What a host class contributes to its entrypoint class. */
export interface HostMembers<Handler extends string> {
  /** RPC methods: the host methods its `rpc` list names. */
  readonly methods: readonly string[];
  /** Event handlers the host implements, in the surface's handler order. */
  readonly handlers: readonly Handler[];
}

/** Why `name` cannot be an RPC method of `host`, or undefined when it can. */
function rpcNameProblem<Handler extends string>(
  host: HostClass,
  name: unknown,
  surface: RpcSurface<Handler>,
): string | undefined {
  if (typeof name !== 'string') {
    return `${host.name}: an rpc entry must be a method name, not ${String(name)}.`;
  }
  if (surface.reserved.has(name)) {
    return (
      `${host.name}.${name}() cannot be a ${surface.label} RPC method: '${name}' is reserved ` +
      `by the ${surface.label} class or its stubs. Rename the method.`
    );
  }
  if (HOOKS.has(name)) {
    return (
      `${host.name}.${name}() cannot be a ${surface.label} RPC method: the application ` +
      'context calls it (a lifecycle, disposal or entrypoint hook).'
    );
  }
  if ((surface.handlers as readonly string[]).includes(name)) {
    return (
      `${host.name}.${name}() is the ${surface.label} ${name} handler, which the platform ` +
      'calls: leave it out of the rpc list.'
    );
  }
  if (!hasPrototypeMethod(host, name)) {
    return (
      `${host.name} has no prototype method ${name}(): list methods declared in the class ` +
      'body, not accessors or instance fields such as arrow functions.'
    );
  }
  return undefined;
}

/**
 * The members of `host` its entrypoint class exposes: the RPC methods `rpc`
 * names, and the event handlers of `surface` it implements. Each `rpc` entry
 * must name a string-keyed method on the host's prototype chain (below
 * `Object.prototype`); a hook, an event handler, a reserved name, an accessor
 * or an instance field throws, and so does a host defining `then`. Nothing
 * else is an RPC method, TypeScript `private` and `protected` methods
 * included. Read at class definition, without constructing the host.
 */
export function hostMembers<Handler extends string>(
  host: HostClass,
  rpc: readonly string[] | undefined,
  surface: RpcSurface<Handler>,
): { methods: string[]; handlers: Handler[] } {
  assertNotThenable(host);
  const names = rpc ?? [];
  if (!Array.isArray(names)) {
    throw new TypeError(`${host.name}: the rpc option must be an array of method names.`);
  }
  const methods: string[] = [];
  for (const name of names) {
    const problem = rpcNameProblem(host, name, surface);
    if (problem !== undefined) throw new TypeError(problem);
    if (!methods.includes(name)) methods.push(name);
  }
  return {
    methods,
    handlers: surface.handlers.filter((name) => hasPrototypeMethod(host, name)),
  };
}
