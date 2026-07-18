import type { Context, Hono } from 'hono';
import { getMetadata, REQUEST_CONTEXT } from '@velajs/vela';
import {
  authenticateWebSocketUpgrade,
  resolveGatewayRoomId,
  resolveGatewayRoomParam,
  resolveMaxFrameBytes,
  WS_GATEWAY_METADATA,
  type WebSocketGatewayOptions,
  type WebSocketUpgradeIdentity,
} from '@velajs/vela/websocket';
import { roomToDurableId } from './room-id';

export interface WsGatewayRoute {
  path: string;
  binding: string;
  options: WebSocketGatewayOptions;
}

const ACCESS_IDENTITY_KEY = Symbol.for('vela.cloudflare-access.identity');
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

interface RequestContextLike {
  get<T>(key: PropertyKey): T | undefined;
}

interface ContainerLike {
  resolve<T>(token: unknown): T;
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
  const container = c.get('container' as never) as ContainerLike | undefined;
  if (!container) return undefined;
  try {
    const value = container
      .resolve<RequestContextLike>(REQUEST_CONTEXT)
      .get<unknown>(ACCESS_IDENTITY_KEY);
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object') return null;

    const candidate = value as Record<string, unknown>;
    const { issuer, subject, principalType, tenantId, expiresAtMs, userId } = candidate;
    if (
      !isIdentityField(issuer) ||
      !isIdentityField(subject) ||
      (principalType !== 'user' && principalType !== 'service') ||
      !isIdentityField(tenantId) ||
      typeof expiresAtMs !== 'number' ||
      !Number.isSafeInteger(expiresAtMs) ||
      expiresAtMs <= 0 ||
      (userId !== undefined && userId !== subject)
    ) {
      return null;
    }
    return {
      principal: { issuer, subject, principalType },
      tenantId,
      expiresAtMs,
    };
  } catch {
    return null;
  }
}

/** `null` means two independently verified identities disagree. */
function combineIdentities(
  requestIdentity: ForwardedIdentity | undefined,
  upgradeIdentity: WebSocketUpgradeIdentity | undefined,
): ForwardedIdentity | null | undefined {
  if (!requestIdentity && !upgradeIdentity) return undefined;
  if (!requestIdentity) return upgradeIdentity as ForwardedIdentity;
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
  } as ForwardedIdentity;
}

/** Read `@WebSocketGateway({ path, binding })` off a resolved instance (CF-hosted gateways only). */
export function collectWsGatewayRoutes(instance: object): WsGatewayRoute[] {
  const options = getMetadata(WS_GATEWAY_METADATA, instance.constructor) as
    | WebSocketGatewayOptions
    | undefined;
  if (!options?.path || !options?.binding) return [];
  resolveGatewayRoomParam(options);
  resolveMaxFrameBytes(options);
  return [{ path: options.path, binding: options.binding, options: { ...options } }];
}

/**
 * Registers the upgrade routes on the Worker's Hono app. Each route validates
 * the `Upgrade` header, resolves the room's Durable Object, and forwards the raw
 * request — injecting spoof-safe `x-vela-*` headers the DO reads. The DO returns
 * the `101` with the client socket.
 */
export function registerWebSocketRoutes(hono: Hono, routes: WsGatewayRoute[]): void {
  for (const route of routes) {
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
      const upgrade = await authenticateWebSocketUpgrade(route.options, sanitizedRequest, roomId);
      if (upgrade === false) return c.text('WebSocket upgrade forbidden', 403);

      const requestIdentity = accessIdentity(c);
      if (requestIdentity === null) return c.text('Invalid WebSocket identity', 403);
      const identity = combineIdentities(requestIdentity, upgrade.identity);
      if (identity === null) return c.text('Conflicting WebSocket identities', 403);
      if (identity && identity.expiresAtMs <= Date.now()) {
        return c.text('WebSocket identity expired', 403);
      }

      const ns = (c.env as Record<string, unknown>)[route.binding] as
        | DurableObjectNamespace
        | undefined;
      if (!ns) {
        return c.text(`Durable Object binding '${route.binding}' is not configured`, 500);
      }

      const stub = ns.get(roomToDurableId(ns, route.path, roomId));

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

      return stub.fetch(new Request(upgrade.request, { headers: forwardHeaders }));
    });
  }
}
