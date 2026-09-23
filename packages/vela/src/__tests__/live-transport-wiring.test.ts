import { describe, expect, it } from 'vitest';
import { Module, VelaFactory, WebSocketModule } from '../index';
import { LiveEngine, LiveModule } from '../live';

describe('LiveModule transport wiring', () => {
  it('fails bootstrap when no WebSocket dispatcher is registered', async () => {
    @Module({ imports: [LiveModule.forRoot({})] })
    class WithoutTransport {}

    await expect(VelaFactory.create(WithoutTransport)).rejects.toThrow(
      /LiveModule serves subscriptions over the '\$live' WebSocket event, but no WsDispatcher is registered/,
    );
  });

  it('boots with a WebSocket module', async () => {
    @Module({ imports: [WebSocketModule.forRoot({}), LiveModule.forRoot({})] })
    class WithTransport {}

    const app = await VelaFactory.create(WithTransport);
    expect(app.get(LiveEngine)).toBeInstanceOf(LiveEngine);
    await app.close();
  });
});
