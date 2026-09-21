import { afterEach, describe, expect, it } from 'vitest';
import { MetadataRegistry, Module, VelaFactory } from '@velajs/vela';
import { WebSocketGateway } from '@velajs/vela/websocket';
import { CloudflareApplication } from '../cloudflare-application';
import { CloudflareWebSocketModule } from '../websocket/cloudflare-websocket.module';

afterEach(() => MetadataRegistry.clear());

describe('gateway entrypoint routes', () => {
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
