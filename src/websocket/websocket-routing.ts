import type { Context, Hono } from 'hono';
import { getMetadata } from '@velajs/vela';
import { WS_GATEWAY_METADATA } from '@velajs/vela/websocket';
import type { WebSocketGatewayOptions } from '@velajs/vela/websocket';
import { roomToDurableId } from './room-id';

export interface WsGatewayRoute {
  path: string;
  binding: string;
}

/** Read `@WebSocketGateway({ path, binding })` off a resolved instance (CF-hosted gateways only). */
export function collectWsGatewayRoutes(instance: object): WsGatewayRoute[] {
  const options = getMetadata(WS_GATEWAY_METADATA, instance.constructor) as
    | WebSocketGatewayOptions
    | undefined;
  if (!options?.path || !options?.binding) return [];
  return [{ path: options.path, binding: options.binding }];
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

      const ns = (c.env as Record<string, unknown>)[route.binding] as
        | DurableObjectNamespace
        | undefined;
      if (!ns) {
        return c.text(`Durable Object binding '${route.binding}' is not configured`, 500);
      }

      const roomId = c.req.param('id') ?? route.path;
      const stub = ns.get(roomToDurableId(ns, roomId));

      // Strip any client-supplied x-vela-* (anti-spoof), then set server values.
      const headers = new Headers(c.req.raw.headers);
      headers.delete('x-vela-room');
      headers.delete('x-vela-path');
      headers.delete('x-vela-user');
      headers.set('x-vela-room', roomId);
      headers.set('x-vela-path', route.path);
      const userId = c.get('userId' as never) as string | undefined;
      if (userId) headers.set('x-vela-user', String(userId));

      return stub.fetch(new Request(c.req.raw, { headers }));
    });
  }
}
