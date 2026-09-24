import { describe, expect, it } from 'vitest';
import { Injectable, Module, Scope } from '@velajs/vela';
import {
  WebSocketGateway,
  WebSocketModule,
  type UpgradeAuthenticator,
  type WebSocketUpgradeIdentity,
} from '@velajs/vela/websocket';
import { createCloudflareApp } from '../cloudflare-factory';

@Injectable()
class TestAuthenticator implements UpgradeAuthenticator {
  authenticate(): WebSocketUpgradeIdentity {
    return {
      principal: { issuer: 'https://issuer.test', subject: 'user-1', principalType: 'user' },
      tenantId: 'tenant-1',
      expiresAtMs: Date.now() + 60_000,
    };
  }
}

/** A namespace whose room objects answer every forwarded upgrade. */
function roomNamespace(forwarded: string[]) {
  return {
    idFromName: (name: string) => ({ toString: () => name, name }),
    get: (id: { toString(): string }) => ({
      fetch: async (request: Request) => {
        forwarded.push(`${id.toString()} ${request.headers.get('x-vela-path')}`);
        return new Response('upgraded', { status: 200 });
      },
    }),
  };
}

describe('gateway upgrade routes', () => {
  it('serves request-scoped gateways without constructing them', async () => {
    let constructed = 0;
    @WebSocketGateway({
      path: '/scoped/:room/ws',
      roomParam: 'room',
      binding: 'ROOMS',
      authenticator: TestAuthenticator,
    })
    @Injectable({ scope: Scope.REQUEST })
    class Gateway {
      constructor() {
        constructed++;
      }
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [Gateway] })
    class App {}

    const forwarded: string[] = [];
    const app = await createCloudflareApp(App, { env: { ROOMS: roomNamespace(forwarded) } });
    try {
      const response = await app
        .getHonoApp()
        .request('/scoped/alpha/ws', { headers: { upgrade: 'websocket' } }, app.env);
      expect(response.status).toBe(200);
      expect(forwarded).toEqual(['vela:ws:v2:%2Fscoped%2F%3Aroom%2Fws:alpha /scoped/:room/ws']);
      expect(constructed).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('serves only gateways that name a binding, once each', async () => {
    @WebSocketGateway({ path: '/rooms/:room/ws', roomParam: 'room', binding: 'ROOMS' })
    class RoomsGateway {}
    @WebSocketGateway({ path: '/local/ws' })
    class LocalGateway {}
    @Module({
      imports: [WebSocketModule.forRoot(), WebSocketModule.forRoot({ key: 'second' })],
      providers: [RoomsGateway, LocalGateway],
    })
    class App {}

    const app = await createCloudflareApp(App, { env: {} });
    try {
      const upgrades = app
        .getHonoApp()
        .routes.filter((route) => route.method === 'GET')
        .map((route) => route.path);
      expect(upgrades).toEqual(['/rooms/:room/ws']);
    } finally {
      await app.close();
    }
  });
});
