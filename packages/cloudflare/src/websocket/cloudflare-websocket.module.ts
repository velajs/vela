import { defineModule, defineProvider } from '@velajs/vela';
import { WsDispatcher, WS_SERVER } from '@velajs/vela/websocket';
import { WsServerHolder } from './ws-server-holder';

/** `CloudflareWebSocketModule` takes no options; `forRoot()` is the uniform entry. */
export type CloudflareWebSocketModuleOptions = Record<never, never>;

const { ConfigurableModuleClass } = defineModule<CloudflareWebSocketModuleOptions>({
  name: 'CloudflareWebSocket',
  setup: () => ({
    // `useClass` ensures a fresh holder per DI container so colocated DO
    // instances never share a server.
    providers: [defineProvider(WS_SERVER, { useClass: WsServerHolder }), WsDispatcher],
    exports: [WS_SERVER, WsDispatcher],
  }),
});

/**
 * Cloudflare counterpart to the core `WebSocketModule.forRoot()`. Import this in
 * your `AppModule` instead: it provides the gateway dispatcher plus a late-bound
 * `WS_SERVER` (`WsServerHolder`) that the WebSocket Durable Object wires to a
 * ctx-backed server per instance.
 */
export class CloudflareWebSocketModule extends ConfigurableModuleClass {}
