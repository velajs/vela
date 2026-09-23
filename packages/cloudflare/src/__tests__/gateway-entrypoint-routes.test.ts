import { describe, expect, it } from 'vitest';
import { Injectable, Module, Scope, VelaFactory } from '@velajs/vela';
import { WebSocketGateway } from '@velajs/vela/websocket';
import { CloudflareApplication } from '../cloudflare-application';
import { CloudflareWebSocketModule } from '../websocket/cloudflare-websocket.module';

describe('gateway entrypoint routes', () => {
  it('discovers request-scoped gateway routes without constructing the gateway', async () => {
    let constructed = 0;
    @WebSocketGateway({ path: '/scoped/:room/ws', roomParam: 'room', binding: 'ROOMS' })
    @Injectable({ scope: Scope.REQUEST })
    class Gateway {
      constructor() {
        constructed++;
      }
    }
    @Module({ imports: [CloudflareWebSocketModule.forRoot()], providers: [Gateway] })
    class App {}
    const vela = await VelaFactory.create(App, { diagnostics: 'silent' });
    const app = new CloudflareApplication(vela, {});
    try {
      expect(constructed).toBe(0);
      expect(vela.getInstances().some((instance) => instance instanceof Gateway)).toBe(false);
      app.scanInstances(vela.getInstances());
      expect(
        app
          .getWsGatewayRoutes()
          .map(({ path, binding, options }) => ({ path, binding, roomParam: options.roomParam })),
      ).toEqual([{ path: '/scoped/:room/ws', binding: 'ROOMS', roomParam: 'room' }]);
      expect(constructed).toBe(0);
    } finally {
      await vela.dispose();
    }
  });

  it('reads validated dispatcher metadata without an instance list and deduplicates rescans', async () => {
    @WebSocketGateway({ path: '/rooms/:room/ws', roomParam: 'room', binding: 'ROOMS' })
    class Gateway {}
    @Module({ imports: [CloudflareWebSocketModule.forRoot()], providers: [Gateway] })
    class App {}
    const vela = await VelaFactory.create(App, { diagnostics: 'silent' });
    const app = new CloudflareApplication(vela, {});
    try {
      app.scanInstances([]);
      expect(app.getWsGatewayRoutes().map(({ path, binding }) => ({ path, binding }))).toEqual([
        { path: '/rooms/:room/ws', binding: 'ROOMS' },
      ]);
      app.scanInstances(vela.getInstances());
      expect(app.getWsGatewayRoutes()).toHaveLength(1);
      app.getWsGatewayRoutes().splice(0);
      expect(app.getWsGatewayRoutes()).toHaveLength(1);
    } finally {
      await vela.dispose();
    }
  });
});
