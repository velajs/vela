import type { Container } from '../container/container';
import { Inject, Injectable, Optional } from '../container/decorators';
import { EntrypointRegistry } from '../entrypoint/entrypoint.registry';
import { Controller } from '../http/decorators';
import type { VelaContext as Context, VelaHono as Hono } from '../http/hono.types';
import { registerRouteContributor } from '../http/route-contributor';
import { getTrustedRequestIdentity } from '../http/trusted-request-identity';
import { defineMetadata } from '../metadata';
import { Module } from '../module/decorators';
import { createWebSocketUpgradeGate, resolveGatewayRoomId } from './gateway-routing';
import { WS_TRANSPORT } from './websocket.tokens';
import type { WebSocketTransport, WebSocketUpgradeIdentity } from './websocket.types';
import { readWsEntrypointMeta, type WsEntrypointMeta } from './ws-dispatcher';

const UPGRADE_ROUTES_METADATA = 'vela:ws-upgrade-routes';
const MAX_IDENTITY_FIELD_BYTES = 2048;
const encoder = new TextEncoder();

/**
 * Marker controller claimed by the upgrade-route contributor. It declares no
 * routes of its own; the contributor mounts one upgrade route per forwarded
 * gateway, outside the global prefix.
 */
@Controller()
class WebSocketUpgradeRoutes {}
defineMetadata(UPGRADE_ROUTES_METADATA, true, WebSocketUpgradeRoutes);

/**
 * The platform transport a runtime adapter registered, when there is one.
 * Every reader (each `WebSocketModule` instance's server and the upgrade
 * routes) takes this one instance, so all of them apply the same precedence:
 * an application's `@Global()` `WS_TRANSPORT` overrides the adapter's.
 */
@Injectable()
export class WebSocketPlatform {
  constructor(@Optional() @Inject(WS_TRANSPORT) readonly transport?: WebSocketTransport) {}
}

/**
 * Imported by every `WebSocketModule` instance. A static module loads once per
 * application, so the upgrade routes mount once however many instances
 * discover the same gateways, and the platform transport resolves once.
 */
@Module({
  controllers: [WebSocketUpgradeRoutes],
  providers: [WebSocketPlatform],
  exports: [WebSocketPlatform],
})
export class WebSocketRoutesModule {}

function isIdentityField(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\r') &&
    !value.includes('\n') &&
    encoder.encode(value).byteLength <= MAX_IDENTITY_FIELD_BYTES
  );
}

/**
 * The request's trusted identity (published by authentication middleware),
 * or `null` when one is present but cannot travel as a socket identity.
 */
function requestIdentity(request: Request): WebSocketUpgradeIdentity | null | undefined {
  const value = getTrustedRequestIdentity(request);
  if (!value) return undefined;
  const { principal, tenantId, expiresAtMs } = value;
  if (
    !isIdentityField(principal.issuer) ||
    !isIdentityField(principal.subject) ||
    !isIdentityField(tenantId) ||
    typeof expiresAtMs !== 'number' ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= 0
  ) {
    return null;
  }
  return {
    principal: {
      issuer: principal.issuer,
      subject: principal.subject,
      principalType: principal.principalType,
    },
    tenantId,
    expiresAtMs,
  };
}

/** `null` means two independently verified identities disagree. */
function reconcile(
  request: WebSocketUpgradeIdentity | undefined,
  upgrade: WebSocketUpgradeIdentity,
): WebSocketUpgradeIdentity | null {
  if (!request) return upgrade;
  if (
    request.principal.issuer !== upgrade.principal.issuer ||
    request.principal.subject !== upgrade.principal.subject ||
    request.principal.principalType !== upgrade.principal.principalType ||
    request.tenantId !== upgrade.tenantId
  ) {
    return null;
  }
  return {
    principal: { ...upgrade.principal },
    tenantId: upgrade.tenantId,
    expiresAtMs: Math.min(request.expiresAtMs, upgrade.expiresAtMs),
  };
}

type ForwardingTransport = WebSocketTransport &
  Required<Pick<WebSocketTransport, 'forwardUpgrade'>>;

/**
 * Serve one gateway's upgrade for a forwarding transport. The route refuses
 * non-upgrades, removes client copies of the transport's headers, resolves the
 * room, and runs the gateway's origin, authorization and authenticator checks
 * before the transport allocates anything remote.
 */
function mountForwardingRoute(
  hono: Hono,
  container: Container,
  transport: ForwardingTransport,
  meta: WsEntrypointMeta,
  binding: string,
): void {
  const authenticate = createWebSocketUpgradeGate(container, meta);
  const reserved = transport.forwardingHeaders ?? [];
  hono.get(meta.path, async (c: Context) => {
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      return c.text('Expected WebSocket upgrade', 426);
    }

    // Transport headers are never application credentials: remove client
    // copies before even the pre-allocation authorization hook sees them.
    const headers = new Headers(c.req.raw.headers);
    for (const name of reserved) headers.delete(name);
    const sanitized = new Request(c.req.raw, { headers });

    let room: string;
    try {
      room = resolveGatewayRoomId(meta.options, (name) => c.req.param(name));
    } catch {
      return c.text('Invalid WebSocket room', 400);
    }

    const upgrade = await authenticate(sanitized, room);
    if (upgrade === false) return c.text('WebSocket upgrade forbidden', 403);

    const trusted = requestIdentity(c.req.raw);
    if (trusted === null) return c.text('Invalid WebSocket identity', 403);
    const identity = reconcile(trusted, upgrade.identity);
    if (identity === null) return c.text('Conflicting WebSocket identities', 403);
    if (identity.expiresAtMs <= Date.now()) return c.text('WebSocket identity expired', 403);

    return transport.forwardUpgrade({
      request: upgrade.request,
      gatewayPath: meta.path,
      room,
      binding,
      identity,
    });
  });
}

registerRouteContributor({
  id: 'vela:websocket-upgrade',
  claimsMetaKey: UPGRADE_ROUTES_METADATA,
  async buildRoutes(app, { container }) {
    if (!container.has(EntrypointRegistry)) return;
    const { transport } = await container.resolveAsync(WebSocketPlatform);
    const forwardUpgrade = transport?.forwardUpgrade?.bind(transport);
    if (!forwardUpgrade) return;
    const forwarding: ForwardingTransport = {
      forwardUpgrade,
      forwardingHeaders: transport?.forwardingHeaders,
    };
    const mounted = new Set<string>();
    const entries = container.resolve(EntrypointRegistry).ofKind('websocket', readWsEntrypointMeta);
    for (const { meta } of entries) {
      const binding = meta.options.binding;
      if (binding === undefined || mounted.has(meta.path)) continue;
      mounted.add(meta.path);
      mountForwardingRoute(app, container, forwarding, meta, binding);
    }
  },
});
