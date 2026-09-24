import type { Type, VelaContext as Context, VelaHono as Hono } from '@velajs/vela';
import type { Container } from '@velajs/vela/module-kit';
import { getMetadata, getTrustedRequestIdentity } from '@velajs/vela/module-kit';
import {
  createWebSocketUpgradeGate,
  resolveGatewayRoomId,
  resolveGatewayRoomParam,
  resolveMaxFrameBytes,
  WS_GATEWAY_METADATA,
  type WebSocketGatewayOptions,
  type WebSocketUpgradeIdentity,
} from '@velajs/vela/websocket';
import { durableObjectRoomName } from './room-id';

export interface WsGatewayRoute {
  path: string;
  binding: string;
  options: WebSocketGatewayOptions;
  /** Container module that declares the gateway; its authenticator resolves from here. */
  moduleId?: string;
}

const MAX_IDENTITY_FIELD_BYTES = 2048;
const encoder = new TextEncoder();

type PrincipalType = 'user' | 'service';

interface ForwardedIdentity extends WebSocketUpgradeIdentity {
  principal: {
    issuer: string;
    subject: string;
    principalType: PrincipalType;
  };
  tenantId: string;
  expiresAtMs: number;
}

function isIdentityField(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\r') &&
    !value.includes('\n') &&
    encoder.encode(value).byteLength <= MAX_IDENTITY_FIELD_BYTES
  );
}

/** `null` means an identity was present but violated the transport contract. */
function accessIdentity(c: Context): ForwardedIdentity | null | undefined {
  const value = getTrustedRequestIdentity(c.req.raw);
  if (!value) return undefined;
  const { principal, tenantId, expiresAtMs } = value;
  if (
    !isIdentityField(principal.issuer) ||
    !isIdentityField(principal.subject) ||
    !isIdentityField(tenantId) ||
    typeof expiresAtMs !== 'number' ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= 0
  )
    return null;
  return { principal, tenantId, expiresAtMs };
}

/** `null` means two independently verified identities disagree. */
function combineIdentities(
  requestIdentity: ForwardedIdentity | undefined,
  upgradeIdentity: WebSocketUpgradeIdentity | undefined,
): ForwardedIdentity | null | undefined {
  if (!requestIdentity && !upgradeIdentity) return undefined;
  if (!requestIdentity) return upgradeIdentity;
  if (!upgradeIdentity) return requestIdentity;
  if (
    requestIdentity.principal.issuer !== upgradeIdentity.principal.issuer ||
    requestIdentity.principal.subject !== upgradeIdentity.principal.subject ||
    requestIdentity.principal.principalType !== upgradeIdentity.principal.principalType ||
    requestIdentity.tenantId !== upgradeIdentity.tenantId
  ) {
    return null;
  }
  return {
    principal: { ...upgradeIdentity.principal },
    tenantId: upgradeIdentity.tenantId,
    expiresAtMs: Math.min(requestIdentity.expiresAtMs, upgradeIdentity.expiresAtMs),
  };
}

/** An instance's constructor is the class token its module registered. */
function isClass(value: unknown): value is Type {
  return typeof value === 'function';
}

/**
 * Read `@WebSocketGateway({ path, binding })` off a resolved instance (CF-hosted
 * gateways only). The application container names the module that declares the
 * gateway when exactly one module registers it.
 */
export function collectWsGatewayRoutes(instance: object, container: Container): WsGatewayRoute[] {
  // Decorator metadata is the framework's explicit reflection boundary.
  const options = getMetadata<WebSocketGatewayOptions>(WS_GATEWAY_METADATA, instance.constructor);
  if (!options?.path || !options?.binding) return [];
  resolveGatewayRoomParam(options);
  resolveMaxFrameBytes(options);
  const gateway: unknown = instance.constructor;
  const owners = isClass(gateway) ? container.getOwnerModuleIds(gateway) : [];
  return [
    {
      path: options.path,
      binding: options.binding,
      options: { ...options },
      ...(owners.length === 1 ? { moduleId: owners[0] } : {}),
    },
  ];
}

/**
 * Registers the upgrade routes on the Worker's Hono app. Each route validates
 * the `Upgrade` header, authenticates through the gateway's authenticator
 * (resolved once from `container`, the application's DI container), resolves
 * the room's Durable Object, and forwards the raw request — injecting
 * spoof-safe `x-vela-*` headers the DO reads. The DO returns the `101` with the
 * client socket.
 */
export function registerWebSocketRoutes(
  hono: Hono,
  routes: WsGatewayRoute[],
  container: Container,
): void {
  for (const route of routes) {
    const authenticate = createWebSocketUpgradeGate(container, route);
    hono.get(route.path, async (c: Context) => {
      if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
        return c.text('Expected WebSocket upgrade', 426);
      }

      // Internal transport headers are never application credentials. Remove
      // client-supplied values before even the pre-allocation authorization
      // hook sees the request, then populate trusted values below.
      const headers = new Headers(c.req.raw.headers);
      headers.delete('x-vela-room');
      headers.delete('x-vela-path');
      headers.delete('x-vela-user');
      headers.delete('x-vela-expires-at');
      headers.delete('x-vela-expires-at-ms');
      headers.delete('x-vela-issuer');
      headers.delete('x-vela-subject');
      headers.delete('x-vela-principal-type');
      headers.delete('x-vela-tenant');
      const sanitizedRequest = new Request(c.req.raw, { headers });

      let roomId: string;
      try {
        roomId = resolveGatewayRoomId(route.options, (name) => c.req.param(name));
      } catch {
        return c.text('Invalid WebSocket room', 400);
      }

      // Origin, application authorization, and ticket/cookie authentication
      // all complete before the gateway Durable Object id is resolved.
      const upgrade = await authenticate(sanitizedRequest, roomId);
      if (upgrade === false) return c.text('WebSocket upgrade forbidden', 403);

      const requestIdentity = accessIdentity(c);
      if (requestIdentity === null) return c.text('Invalid WebSocket identity', 403);
      const identity = combineIdentities(requestIdentity, upgrade.identity);
      if (identity === null) return c.text('Conflicting WebSocket identities', 403);
      if (identity && identity.expiresAtMs <= Date.now()) {
        return c.text('WebSocket identity expired', 403);
      }

      // Populate the ticket-free forwarding request with trusted server values.
      const forwardHeaders = new Headers(upgrade.request.headers);
      forwardHeaders.set('x-vela-room', roomId);
      forwardHeaders.set('x-vela-path', route.path);
      if (identity) {
        forwardHeaders.set('x-vela-user', identity.principal.subject);
        forwardHeaders.set('x-vela-issuer', identity.principal.issuer);
        forwardHeaders.set('x-vela-subject', identity.principal.subject);
        forwardHeaders.set('x-vela-principal-type', identity.principal.principalType);
        forwardHeaders.set('x-vela-tenant', identity.tenantId);
        forwardHeaders.set('x-vela-expires-at-ms', String(identity.expiresAtMs));
      }

      return forwardToRoom(
        c.env,
        route.binding,
        route.path,
        roomId,
        new Request(upgrade.request, { headers: forwardHeaders }),
      );
    });
  }
}

/**
 * Gateway metadata contains a runtime binding name, so the native type is
 * erased. Validate only the operations consumed here and their observable
 * results; never assert that an arbitrary value implements a native namespace.
 */
async function forwardToRoom(
  env: unknown,
  binding: string,
  path: string,
  room: string,
  request: Request,
): Promise<Response> {
  if (typeof env !== 'object' || env === null) throw new Error('Worker environment is missing');
  const namespace: unknown = Reflect.get(env, binding);
  if (typeof namespace !== 'object' || namespace === null) {
    return new Response(`Durable Object binding '${binding}' is not configured`, { status: 500 });
  }
  const idFromName: unknown = Reflect.get(namespace, 'idFromName');
  const get: unknown = Reflect.get(namespace, 'get');
  if (typeof idFromName !== 'function' || typeof get !== 'function') {
    throw new Error('Invalid Durable Object namespace');
  }
  const id: unknown = Reflect.apply(idFromName, namespace, [durableObjectRoomName(path, room)]);
  const stub: unknown = Reflect.apply(get, namespace, [id]);
  if (typeof stub !== 'object' || stub === null) throw new Error('Invalid Durable Object stub');
  const fetch: unknown = Reflect.get(stub, 'fetch');
  if (typeof fetch !== 'function') throw new Error('Durable Object stub has no fetch operation');
  const response: unknown = await Reflect.apply(fetch, stub, [request]);
  if (!(response instanceof Response))
    throw new Error('Durable Object returned an invalid response');
  return response;
}
