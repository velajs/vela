import { defineProvider } from '@velajs/vela';
import type { VelaEnv } from '@velajs/vela';
import { LIVE_PLATFORM, type LivePlatform } from '@velajs/vela/live';
import type { Container } from '@velajs/vela/module-kit';
import { WS_TRANSPORT, type WebSocketTransport } from '@velajs/vela/websocket';
import { registerCloudflareEnvironment } from './environment';

/** What one isolate, the Worker or a WebSocket Durable Object, gives the application. */
export interface CloudflarePlatform {
  websocket: WebSocketTransport;
  live: LivePlatform;
}

/**
 * Seed the application's ENV and its platform wiring, as global tokens,
 * before any module loads: `WebSocketModule` and `LiveModule` read
 * `WS_TRANSPORT` and `LIVE_PLATFORM` from here. Module providers are never
 * replaced; an application without those modules never reads either token.
 */
export function registerCloudflarePlatform(
  container: Container,
  env: VelaEnv,
  platform: CloudflarePlatform,
): void {
  registerCloudflareEnvironment(container, env);
  container.register(defineProvider(WS_TRANSPORT, { useValue: platform.websocket }));
  container.markGlobalToken(WS_TRANSPORT);
  container.register(defineProvider(LIVE_PLATFORM, { useValue: platform.live }));
  container.markGlobalToken(LIVE_PLATFORM);
}
