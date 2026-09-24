import type { VelaEnv } from '@velajs/vela';
import type { ForwardedWebSocketUpgrade, WebSocketTransport } from '@velajs/vela/websocket';
import { durableObjectRoomName } from './room-id';

/**
 * Headers that carry trusted upgrade values from the Worker's upgrade route to
 * the room's Durable Object. The route removes client copies before any
 * application hook runs; the Durable Object reads only these.
 */
export const FORWARDED_UPGRADE_HEADERS = {
  room: 'x-vela-room',
  path: 'x-vela-path',
  user: 'x-vela-user',
  issuer: 'x-vela-issuer',
  subject: 'x-vela-subject',
  principalType: 'x-vela-principal-type',
  tenant: 'x-vela-tenant',
  expiresAtMs: 'x-vela-expires-at-ms',
} as const;

const FORWARDING_HEADERS: readonly string[] = [
  ...Object.values(FORWARDED_UPGRADE_HEADERS),
  // Retired header name: still removed so a client can never supply it.
  'x-vela-expires-at',
];

function operation(target: object, name: string): Function {
  const value: unknown = Reflect.get(target, name);
  if (typeof value !== 'function') throw new Error(`Durable Object ${name}() is unavailable`);
  return value;
}

/** One gateway room's Durable Object: its id, and calls to its operations. */
export interface GatewayRoomObject {
  readonly id: unknown;
  call(method: string, ...args: unknown[]): Promise<unknown>;
}

/**
 * The Durable Object that holds one gateway room, one object per gateway and
 * room, in the namespace the gateway's `binding` names in ENV. Gateway
 * metadata contains a runtime binding name, so the native type is erased:
 * validate only the operations consumed here, never assert that an arbitrary
 * value implements a native namespace.
 */
export function gatewayRoomObject(
  env: VelaEnv,
  gatewayPath: string,
  binding: string | undefined,
  room: string,
): GatewayRoomObject {
  if (binding === undefined) {
    throw new Error(
      `Gateway '${gatewayPath}' names no binding: declare @WebSocketGateway({ binding })`,
    );
  }
  const namespace: unknown = Reflect.get(env, binding);
  if (typeof namespace !== 'object' || namespace === null) {
    throw new Error(`Gateway '${gatewayPath}' has no Durable Object binding '${binding}' in ENV`);
  }
  const id: unknown = Reflect.apply(operation(namespace, 'idFromName'), namespace, [
    durableObjectRoomName(gatewayPath, room),
  ]);
  return {
    id,
    async call(method, ...args) {
      const stub: unknown = Reflect.apply(operation(namespace, 'get'), namespace, [id]);
      if (typeof stub !== 'object' || stub === null) throw new Error('Invalid Durable Object stub');
      return Reflect.apply(operation(stub, method), stub, args);
    },
  };
}

/**
 * The Worker isolate's WebSocket transport. Sockets live in each gateway
 * room's Durable Object, so the Worker keeps none: `Gateways` pushes become a
 * `broadcast` RPC to the room's object (the server gateways inject refuses
 * pushes with guidance to `Gateways`), and each authenticated upgrade goes to
 * the object named by the gateway's `binding`, carrying the verified identity
 * in {@link FORWARDED_UPGRADE_HEADERS}. The Durable Object returns the `101`
 * with the client socket.
 */
export function workerWebSocketTransport(env: VelaEnv): WebSocketTransport {
  return {
    forwardingHeaders: FORWARDING_HEADERS,
    async deliver({ gatewayPath, binding, room, command }) {
      await gatewayRoomObject(env, gatewayPath, binding, room).call('broadcast', command);
    },
    async forwardUpgrade({
      request,
      gatewayPath,
      room,
      binding,
      identity,
    }: ForwardedWebSocketUpgrade) {
      const headers = new Headers(request.headers);
      const names = FORWARDED_UPGRADE_HEADERS;
      headers.set(names.room, room);
      headers.set(names.path, gatewayPath);
      headers.set(names.user, identity.principal.subject);
      headers.set(names.issuer, identity.principal.issuer);
      headers.set(names.subject, identity.principal.subject);
      headers.set(names.principalType, identity.principal.principalType);
      headers.set(names.tenant, identity.tenantId);
      headers.set(names.expiresAtMs, String(identity.expiresAtMs));
      const response: unknown = await gatewayRoomObject(env, gatewayPath, binding, room).call(
        'fetch',
        new Request(request, { headers }),
      );
      if (!(response instanceof Response)) {
        throw new Error('Durable Object returned an invalid response');
      }
      return response;
    },
  };
}
