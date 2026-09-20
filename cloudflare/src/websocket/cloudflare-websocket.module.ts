import { defineProvider, type DynamicModule } from '@velajs/vela';
import { WsDispatcher, WS_SERVER } from '@velajs/vela/websocket';
import { WsServerHolder } from './ws-server-holder';

/**
 * Cloudflare counterpart to the core `WebSocketModule.forRoot()`. Import this in
 * your `AppModule` instead: it provides the gateway dispatcher plus a late-bound
 * `WS_SERVER` (`WsServerHolder`) that the WebSocket Durable Object wires to a
 * ctx-backed server per instance. `useClass` ensures a fresh holder per DI
 * container so colocated DO instances never share a server.
 */
export class CloudflareWebSocketModule {
  static forRoot(): DynamicModule {
    const providers = [defineProvider(WS_SERVER, { useClass: WsServerHolder }), WsDispatcher];

    return {
      module: CloudflareWebSocketModule,
      providers,
      exports: [WS_SERVER, WsDispatcher],
    };
  }
}
