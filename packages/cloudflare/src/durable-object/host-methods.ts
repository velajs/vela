import {
  hostMembers,
  type HostClass,
  type HostMembers,
  type RpcSurface,
} from '../host/host-members';

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
 * the stub members that shadow any RPC method of that name (`connect()`, a
 * TCP socket, `dup()`, and the `id` and `name` properties), and `then`, which
 * would make the stub and its results thenables.
 */
const DURABLE_OBJECT: RpcSurface<DurableObjectHandlerName> = {
  label: 'Durable Object',
  reserved: new Set(['ctx', 'env', 'connect', 'dup', 'id', 'name', 'then']),
  handlers: DURABLE_OBJECT_HANDLERS,
};

/** What a host class contributes to its Durable Object class. */
export type DurableObjectHostMembers = HostMembers<DurableObjectHandlerName>;

/**
 * The members of `host` its Durable Object class exposes: the RPC methods
 * `rpc` names, and the event handlers it implements. Each `rpc` entry must
 * name a string-keyed method on the host's prototype chain (below
 * `Object.prototype`); a hook, an event handler, a name the Durable Object or
 * its stubs own, an accessor or an instance field throws, and so does a host
 * whose prototype defines `then`. Nothing else is an RPC method, TypeScript
 * `private` and `protected` methods included. `fetch`, `alarm` and the
 * WebSocket handlers, when the host defines them, become the object's
 * handlers. Read at class definition, without constructing the host.
 */
export function durableObjectHostMembers(
  host: HostClass,
  rpc?: readonly string[],
): {
  methods: string[];
  handlers: DurableObjectHandlerName[];
} {
  return hostMembers(host, rpc, DURABLE_OBJECT);
}
