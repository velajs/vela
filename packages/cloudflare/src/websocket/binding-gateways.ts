import type { Container, DiscoveryService } from '@velajs/vela/module-kit';
import {
  WS_GATEWAY_METADATA,
  WS_SERVER,
  type WebSocketGatewayOptions,
} from '@velajs/vela/websocket';
import { reportDiagnostic } from '../diagnostics';

/** A gateway whose rooms live in Durable Objects: its path and namespace binding. */
export interface BindingGateway {
  path: string;
  binding: string;
  /**
   * The gateway declares no `roomParam`: every upgrade joins one room, its
   * path, so one Durable Object holds every socket.
   */
  oneRoom: boolean;
  /** The gateway class name, for diagnostics. */
  name: string;
}

/**
 * The application's gateways that name a `binding`, in discovery order, once
 * per path. Read from decorator metadata, so lifecycle hooks can use it.
 */
export function bindingGateways(discovery: DiscoveryService): BindingGateway[] {
  const gateways = new Map<string, BindingGateway>();
  for (const { metatype, meta } of discovery.providersWithMeta<WebSocketGatewayOptions>(
    WS_GATEWAY_METADATA,
    { metadataOnly: true },
  )) {
    const path = meta.path ?? '';
    if (typeof meta.binding !== 'string' || gateways.has(path)) continue;
    gateways.set(path, {
      path,
      binding: meta.binding,
      oneRoom: meta.roomParam === undefined,
      name: metatype.name,
    });
  }
  return [...gateways.values()];
}

/**
 * `WebSocketModule` mounts the Worker's upgrade routes. An application with a
 * binding-backed gateway but without that module answers its upgrades with
 * 404, so report each such gateway through the diagnostics policy.
 */
export function reportUnservedGateways(container: Container, discovery: DiscoveryService): void {
  if (container.has(WS_SERVER)) return;
  for (const { name, binding, path } of bindingGateways(discovery)) {
    reportDiagnostic(
      container,
      `[vela] ${name} is a @WebSocketGateway with binding '${binding}', but the application ` +
        `does not import WebSocketModule.forRoot() from @velajs/vela/websocket, so upgrades ` +
        `to '${path}' answer 404 instead of reaching its Durable Object.`,
    );
  }
}
