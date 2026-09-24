import type { VelaEnv } from '@velajs/vela';
import type {
  BroadcastOperator,
  ForwardedWebSocketUpgrade,
  WebSocketTransport,
  WsServer,
} from '@velajs/vela/websocket';
import { resolveBinding } from '@velajs/vela/module-kit';
import { DURABLE_OBJECT_NAMESPACE } from '../bindings';
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

const WORKER_SERVER_UNAVAILABLE =
  'The WebSocket server is only available inside the WebSocket Durable Object that holds ' +
  "the gateway's sockets. To push from the Worker, use broadcastToRoom(namespace, " +
  'gatewayPath, room, event, data).';

/**
 * The server gateways receive in the Worker isolate. Sockets live in each
 * room's Durable Object, so every push from here fails with guidance instead of
 * reaching nobody.
 */
class WorkerWebSocketServer implements WsServer {
  emit(): never {
    throw new Error(WORKER_SERVER_UNAVAILABLE);
  }
  to(): BroadcastOperator {
    throw new Error(WORKER_SERVER_UNAVAILABLE);
  }
  in(): BroadcastOperator {
    throw new Error(WORKER_SERVER_UNAVAILABLE);
  }
  except(): BroadcastOperator {
    throw new Error(WORKER_SERVER_UNAVAILABLE);
  }
}

/**
 * Gateway metadata contains a runtime binding name, so the native type is
 * erased. Validate only the operations consumed here and their observable
 * results; never assert that an arbitrary value implements a native namespace.
 */
async function forwardToRoom(
  env: VelaEnv,
  binding: string,
  gatewayPath: string,
  room: string,
  request: Request,
): Promise<Response> {
  const namespace = resolveBinding(env, { binding }, DURABLE_OBJECT_NAMESPACE);
  const stub: unknown = namespace.get(namespace.idFromName(durableObjectRoomName(gatewayPath, room)));
  if (typeof stub !== 'object' || stub === null) throw new Error('Invalid Durable Object stub');
  const fetch: unknown = Reflect.get(stub, 'fetch');
  if (typeof fetch !== 'function') throw new Error('Durable Object stub has no fetch operation');
  const response: unknown = await Reflect.apply(fetch, stub, [request]);
  if (!(response instanceof Response)) {
    throw new Error('Durable Object returned an invalid response');
  }
  return response;
}

/**
 * The Worker isolate's WebSocket transport: gateways get a server that refuses
 * pushes, and each authenticated upgrade goes to the Durable Object named by
 * the gateway's `binding`, one object per gateway and room, carrying the
 * verified identity in {@link FORWARDED_UPGRADE_HEADERS}. The Durable Object
 * returns the `101` with the client socket.
 */
export function workerWebSocketTransport(env: VelaEnv): WebSocketTransport {
  return {
    forwardingHeaders: FORWARDING_HEADERS,
    createServer: () => new WorkerWebSocketServer(),
    forwardUpgrade({ request, gatewayPath, room, binding, identity }: ForwardedWebSocketUpgrade) {
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
      return forwardToRoom(env, binding, gatewayPath, room, new Request(request, { headers }));
    },
  };
}
