// Exercise native streams and finalization with the same portable HTTP contract.
import '../http-execution-lifetime.test';

import { describe, expect, it } from 'vitest';
import { Controller, Get, Injectable, Module, Scope, VelaFactory } from '../../index';

describe('native HTTP upgrade lifetime', () => {
  it('preserves WebSocket response fields and closes the HTTP resource scope', async () => {
    let disposed = 0;
    const pair = new WebSocketPair();
    pair[1].accept();
    @Injectable({ scope: Scope.REQUEST })
    class Resource {
      dispose() {
        disposed++;
      }
    }
    @Controller('/upgrade')
    class Routes {
      constructor(readonly resource: Resource) {}
      @Get()
      upgrade() {
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
    }
    @Module({ controllers: [Routes], providers: [Resource] })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      const response = await app.fetch(
        new Request('http://test/upgrade', { headers: { upgrade: 'websocket' } }),
      );
      expect(response.status).toBe(101);
      expect(response.webSocket).toBe(pair[0]);
      expect(disposed).toBe(1);
      pair[0].accept();
    } finally {
      pair[1].close();
      await app.close();
    }
  });
});
