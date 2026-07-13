import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MetadataRegistry,
  VelaFactory,
  Module,
  Injectable,
  UseGuards,
  UseInterceptors,
  UseFilters,
  Catch,
  APP_GUARD,
} from '../index.js';
import { VelaError } from '@velajs/errors';
import type {
  CanActivate,
  NestInterceptor,
  ExceptionFilter,
  ExecutionContext,
  CallHandler,
} from '../index.js';
import { buildWsExecutionContext } from '../websocket/ws-execution-context.js';
import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  ReservedWsEvent,
} from '../websocket/websocket.decorators.js';
import {
  WS_GATEWAY_METADATA,
  WS_SUBSCRIBE_METADATA,
  WsParamType,
} from '../websocket/websocket.tokens.js';
import { WebSocketModule } from '../websocket/websocket.module.js';
import { WsDispatcher } from '../websocket/ws-dispatcher.js';
import { WsException } from '../websocket/ws-exception.js';
import { WebSocketServer } from '../websocket/websocket.decorators.js';
import { InMemoryRoomRegistry, local } from '../websocket/ws-sync.js';
import { WsServerImpl } from '../websocket/ws-server.js';
import { WS_ROOM_REGISTRY } from '../websocket/websocket.tokens.js';
import type {
  WsClient,
  WsServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ReservedWsEventHandler,
} from '../websocket/websocket.types.js';

type SinkClient = WsClient & { received: Array<{ event: string; data: unknown }> };

function sink(id: string): SinkClient {
  const received: Array<{ event: string; data: unknown }> = [];
  return {
    id,
    rooms: new Set(),
    data: {},
    raw: null,
    received,
    send() {},
    sendRaw(payload: string) {
      received.push(JSON.parse(payload));
    },
    join() {},
    leave() {},
    commit() {},
    close() {},
  };
}

interface Sent {
  event: string;
  data: unknown;
  id?: string;
}

class FakeClient implements WsClient {
  readonly rooms = new Set<string>();
  data: Record<string, unknown> = {};
  readonly raw = null;
  readonly sent: Sent[] = [];
  constructor(public readonly id = 'c1') {}
  send(event: string, data?: unknown, id?: string): void {
    this.sent.push({ event, data, id });
  }
  sendRaw(payload: string): void {
    this.sent.push({ event: '__raw__', data: payload });
  }
  join(): void {}
  leave(): void {}
  commit(): void {}
  close(): void {}
}

const frame = (event: string, data: unknown, id?: string): string =>
  JSON.stringify(id !== undefined ? { id, event, data } : { event, data });

describe('buildWsExecutionContext', () => {
  class ChatGateway {}
  const client = { id: 'c1' } as never;

  it('reports a ws context type with client/data/pattern access', () => {
    const ctx = buildWsExecutionContext(client, { hi: 1 }, ChatGateway as never, 'onChat', 'chat');

    expect(ctx.getType()).toBe('ws');
    expect(ctx.getClass()).toBe(ChatGateway);
    expect(ctx.getHandler()).toBe('onChat');
    expect(ctx.switchToWs().getClient()).toBe(client);
    expect(ctx.switchToWs().getData()).toEqual({ hi: 1 });
    expect(ctx.switchToWs().getPattern()).toBe('chat');
  });

  it('throws when HTTP accessors are used on a ws context', () => {
    const ctx = buildWsExecutionContext(client, undefined, ChatGateway as never, 'onChat', 'chat');

    expect(() => ctx.switchToHttp()).toThrow();
    expect(() => ctx.getRequest()).toThrow();
    expect(() => ctx.getContext()).toThrow();
  });
});

describe('gateway decorators', () => {
  it('stores gateway options and a flat list of @SubscribeMessage handlers', () => {
    @WebSocketGateway({ path: '/chat', binding: 'CHAT' })
    class ChatGateway {
      @SubscribeMessage('msg')
      onMsg() {}
      @SubscribeMessage('ping')
      onPing() {}
    }

    expect(MetadataRegistry.getCustomClassMeta(ChatGateway, WS_GATEWAY_METADATA)).toEqual({
      path: '/chat',
      binding: 'CHAT',
    });
    expect(MetadataRegistry.getCustomClassMeta(ChatGateway, WS_SUBSCRIBE_METADATA)).toEqual([
      { event: 'msg', methodName: 'onMsg' },
      { event: 'ping', methodName: 'onPing' },
    ]);
  });

  it('marks the gateway injectable so the DI container can resolve it', () => {
    @WebSocketGateway({ path: '/x' })
    class Gateway {}
    expect(MetadataRegistry.hasInjectable(Gateway)).toBe(true);
  });

  it('registers @MessageBody and @ConnectedSocket params by kind and index', () => {
    @WebSocketGateway({ path: '/x' })
    class Gateway {
      @SubscribeMessage('e')
      handle(@MessageBody() _body: unknown, @ConnectedSocket() _client: unknown) {}
    }

    const params = [...(MetadataRegistry.getParameters(Gateway).get('handle') ?? [])].sort(
      (a, b) => a.index - b.index,
    );
    expect(params.map((p) => p.type)).toEqual([WsParamType.BODY, WsParamType.SOCKET]);
  });
});

describe('WsDispatcher', () => {
  beforeEach(() => MetadataRegistry.clear());

  it('routes a message to the matching @SubscribeMessage handler and frames the WsResponse', async () => {
    @WebSocketGateway({ path: '/chat' })
    class ChatGateway {
      @SubscribeMessage('echo')
      onEcho(@MessageBody() body: { text: string }) {
        return { event: 'echo', data: body.text.toUpperCase() };
      }
    }

    @Module({ imports: [WebSocketModule.forRoot()], providers: [ChatGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const dispatcher = app.get(WsDispatcher);
    const client = new FakeClient();

    await dispatcher.dispatchMessage('/chat', client, frame('echo', { text: 'hi' }, '1'));

    expect(client.sent).toEqual([{ event: 'echo', data: 'HI', id: '1' }]);
  });

  it('injects @ConnectedSocket and @MessageBody in declared order; no reply when handler returns void', async () => {
    @WebSocketGateway({ path: '/rev' })
    class RevGateway {
      @SubscribeMessage('rev')
      onRev(@ConnectedSocket() socket: WsClient, @MessageBody() body: string) {
        socket.send('rev', body.split('').reverse().join(''));
      }
    }

    @Module({ imports: [WebSocketModule.forRoot()], providers: [RevGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const client = new FakeClient();

    await app.get(WsDispatcher).dispatchMessage('/rev', client, frame('rev', 'hello'));

    expect(client.sent).toEqual([{ event: 'rev', data: 'olleh', id: undefined }]);
  });

  it('ignores unknown events', async () => {
    @WebSocketGateway({ path: '/u' })
    class UGateway {
      @SubscribeMessage('known')
      onKnown() {
        return { event: 'known', data: 1 };
      }
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [UGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const client = new FakeClient();
    await app.get(WsDispatcher).dispatchMessage('/u', client, frame('nope', {}));
    expect(client.sent).toEqual([]);
  });

  it('reuses guards through the WsExecutionContext and blocks the handler on deny', async () => {
    @Injectable()
    class WsOnlyDenyGuard implements CanActivate {
      canActivate(ctx: ExecutionContext): boolean {
        return ctx.getType() !== 'ws';
      }
    }

    @WebSocketGateway({ path: '/g' })
    class GuardedGateway {
      @SubscribeMessage('secret')
      @UseGuards(WsOnlyDenyGuard)
      onSecret() {
        return { event: 'secret', data: 'leaked' };
      }
    }

    @Module({ imports: [WebSocketModule.forRoot()], providers: [GuardedGateway, WsOnlyDenyGuard] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const client = new FakeClient();

    await app.get(WsDispatcher).dispatchMessage('/g', client, frame('secret', {}, '7'));

    expect(client.sent).toEqual([{ event: 'exception', data: { message: 'Forbidden' }, id: '7' }]);
  });

  it('reuses the interceptor onion chain', async () => {
    @Injectable()
    class WrapInterceptor implements NestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler): Promise<unknown> {
        const result = await next.handle();
        return { event: 'wrapped', data: result };
      }
    }

    @WebSocketGateway({ path: '/i' })
    class InterceptGateway {
      @SubscribeMessage('go')
      @UseInterceptors(WrapInterceptor)
      onGo() {
        return 'inner';
      }
    }

    @Module({
      imports: [WebSocketModule.forRoot()],
      providers: [InterceptGateway, WrapInterceptor],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const client = new FakeClient();

    await app.get(WsDispatcher).dispatchMessage('/i', client, frame('go', {}));

    expect(client.sent).toEqual([{ event: 'wrapped', data: 'inner', id: undefined }]);
  });

  it('routes thrown WsException through a matching @Catch exception filter', async () => {
    @Catch(WsException)
    class CatchWs implements ExceptionFilter {
      catch(err: WsException, ctx: ExecutionContext): void {
        ctx.switchToWs().getClient<WsClient>().send('caught', err.getError());
      }
    }

    @WebSocketGateway({ path: '/f' })
    class FilterGateway {
      @SubscribeMessage('boom')
      @UseFilters(CatchWs)
      onBoom() {
        throw new WsException('nope');
      }
    }

    @Module({ imports: [WebSocketModule.forRoot()], providers: [FilterGateway, CatchWs] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const client = new FakeClient();

    await app.get(WsDispatcher).dispatchMessage('/f', client, frame('boom', {}));

    expect(client.sent).toEqual([{ event: 'caught', data: 'nope', id: undefined }]);
  });

  it('fires OnGatewayConnection / OnGatewayDisconnect lifecycle hooks', async () => {
    @WebSocketGateway({ path: '/l' })
    class LifecycleGateway implements OnGatewayConnection, OnGatewayDisconnect {
      readonly events: string[] = [];
      handleConnection(c: WsClient) {
        this.events.push(`open:${c.id}`);
      }
      handleDisconnect(c: WsClient) {
        this.events.push(`close:${c.id}`);
      }
    }

    @Module({ imports: [WebSocketModule.forRoot()], providers: [LifecycleGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const dispatcher = app.get(WsDispatcher);
    const gateway = app.get(LifecycleGateway);
    const client = new FakeClient('c9');

    await dispatcher.handleOpen('/l', client);
    await dispatcher.handleClose('/l', client, 1000, 'bye');

    expect(gateway.events).toEqual(['open:c9', 'close:c9']);
  });

  it('replies with a default exception frame when no filter matches', async () => {
    @WebSocketGateway({ path: '/e' })
    class ErrGateway {
      @SubscribeMessage('crash')
      onCrash() {
        throw new WsException({ code: 'BAD', message: 'boom' });
      }
    }

    @Module({ imports: [WebSocketModule.forRoot()], providers: [ErrGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const client = new FakeClient();

    await app.get(WsDispatcher).dispatchMessage('/e', client, frame('crash', {}, 'z'));

    expect(client.sent).toEqual([
      { event: 'exception', data: { code: 'BAD', message: 'boom' }, id: 'z' },
    ]);
  });
});

describe('rooms + Server handle', () => {
  it('delivers to room members only', () => {
    const registry = new InMemoryRoomRegistry();
    const driver = local();
    driver.bind(registry);
    const server = new WsServerImpl(driver);

    const a = sink('a');
    const b = sink('b');
    const c = sink('c');
    registry.join(a, 'r1');
    registry.join(b, 'r1');
    registry.join(c, 'r2');

    server.to('r1').emit('hello', { n: 1 });

    expect(a.received).toEqual([{ event: 'hello', data: { n: 1 } }]);
    expect(b.received).toEqual([{ event: 'hello', data: { n: 1 } }]);
    expect(c.received).toEqual([]);
  });

  it('global emit reaches every connection', () => {
    const registry = new InMemoryRoomRegistry();
    const driver = local();
    driver.bind(registry);
    const server = new WsServerImpl(driver);

    const a = sink('a');
    const b = sink('b');
    registry.join(a, 'r1');
    registry.join(b, 'r2');

    server.emit('ping', 1);

    expect(a.received).toEqual([{ event: 'ping', data: 1 }]);
    expect(b.received).toEqual([{ event: 'ping', data: 1 }]);
  });

  it('except(room) excludes those members and unioned rooms dedup per connection', () => {
    const registry = new InMemoryRoomRegistry();
    const driver = local();
    driver.bind(registry);
    const server = new WsServerImpl(driver);

    const a = sink('a');
    const b = sink('b');
    const d = sink('d');
    registry.join(a, 'r1');
    registry.join(b, 'r1');
    registry.join(d, 'r1');
    registry.join(d, 'r2'); // d is in both r1 and r2

    server.to('r1').except('r2').emit('x', 1);
    expect(a.received).toHaveLength(1);
    expect(b.received).toHaveLength(1);
    expect(d.received).toHaveLength(0); // excluded via r2 membership

    a.received.length = 0;
    b.received.length = 0;
    d.received.length = 0;

    server.to('r1').in('r2').emit('y', 2); // union r1 ∪ r2
    expect(a.received).toHaveLength(1);
    expect(b.received).toHaveLength(1);
    expect(d.received).toHaveLength(1); // in both, delivered once
  });

  it('exceptIds excludes a specific connection (client self-exclusion primitive)', () => {
    const registry = new InMemoryRoomRegistry();
    const a = sink('a');
    const b = sink('b');
    registry.join(a, 'r1');
    registry.join(b, 'r1');

    registry.deliverLocal({
      rooms: ['r1'],
      exceptIds: ['a'],
      frame: JSON.stringify({ event: 'z', data: 3 }),
    });

    expect(a.received).toEqual([]);
    expect(b.received).toEqual([{ event: 'z', data: 3 }]);
  });

  it('injects @WebSocketServer, broadcasts from a handler, and fires afterInit', async () => {
    const initServers: WsServer[] = [];

    @WebSocketGateway({ path: '/rooms' })
    class RoomGateway implements OnGatewayInit {
      constructor(@WebSocketServer() private readonly server: WsServer) {}
      afterInit(server: WsServer) {
        initServers.push(server);
      }
      @SubscribeMessage('shout')
      onShout(@MessageBody() msg: string) {
        this.server.to('r1').emit('shout', msg);
      }
    }

    @Module({ imports: [WebSocketModule.forRoot()], providers: [RoomGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const registry = app.get(WS_ROOM_REGISTRY);
    const listener = sink('listener');
    registry.join(listener, 'r1');

    await app.get(WsDispatcher).dispatchMessage('/rooms', new FakeClient(), frame('shout', 'hey'));

    expect(listener.received).toEqual([{ event: 'shout', data: 'hey' }]);
    expect(initServers).toHaveLength(1);
  });
});

describe('WsDispatcher — code-review regressions', () => {
  beforeEach(() => MetadataRegistry.clear());

  it('runs APP_GUARD global guards on gateway messages (security)', async () => {
    @Injectable()
    class GlobalDenyGuard implements CanActivate {
      canActivate(ctx: ExecutionContext): boolean {
        return ctx.getType() !== 'ws';
      }
    }

    @WebSocketGateway({ path: '/global-guard' })
    class Gateway {
      @SubscribeMessage('secret')
      onSecret() {
        return { event: 'secret', data: 'leaked' };
      }
    }

    @Module({
      imports: [WebSocketModule.forRoot()],
      providers: [Gateway, { provide: APP_GUARD, useClass: GlobalDenyGuard }],
    })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const client = new FakeClient();
    await app.get(WsDispatcher).dispatchMessage('/global-guard', client, frame('secret', {}, '1'));

    expect(client.sent).toEqual([{ event: 'exception', data: { message: 'Forbidden' }, id: '1' }]);
  });

  it('falls back to a default exception frame when an exception filter throws', async () => {
    @Catch(WsException)
    class BrokenFilter implements ExceptionFilter {
      catch(): void {
        throw new Error('filter blew up');
      }
    }

    @WebSocketGateway({ path: '/broken-filter' })
    class Gateway {
      @SubscribeMessage('boom')
      @UseFilters(BrokenFilter)
      onBoom() {
        throw new WsException({ code: 'X', message: 'orig' });
      }
    }

    @Module({ imports: [WebSocketModule.forRoot()], providers: [Gateway, BrokenFilter] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const client = new FakeClient();
    await app.get(WsDispatcher).dispatchMessage('/broken-filter', client, frame('boom', {}, '9'));

    expect(client.sent).toEqual([
      { event: 'exception', data: { code: 'X', message: 'orig' }, id: '9' },
    ]);
  });

  it('does not throw when the client socket is dead mid-dispatch', async () => {
    @WebSocketGateway({ path: '/dead' })
    class Gateway {
      @SubscribeMessage('echo')
      onEcho(@MessageBody() body: unknown) {
        return { event: 'echo', data: body };
      }
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [Gateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const dead = new FakeClient();
    (dead as unknown as { send: () => void }).send = () => {
      throw new Error('socket closed');
    };
    // Must resolve, not reject, even though send() throws.
    await expect(
      app.get(WsDispatcher).dispatchMessage('/dead', dead, frame('echo', { a: 1 })),
    ).resolves.toBeUndefined();
  });
});

// =============================================================================
// Task 9 — WS edge: exception frames route through `toErrorBody` (the single
// wire-redaction seam) and the dispatcher REPORTS every error before filtering.
//
//   1. a branded VelaError serializes to its canonical `{ code, message }`;
//   2. an unbranded Error is redacted to the internal frame — its raw message
//      surfaces ONLY through the reporter (default reporter → console.error);
//   3. a WsException still ships its own payload verbatim (unchanged);
//   4. the report fires FIRST, even when a filter claims the error, and a
//      throwing filter is itself reported (`note: 'exception filter threw'`).
// =============================================================================
describe('WsDispatcher — exception frames through toErrorBody (Task 9)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    MetadataRegistry.clear();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('branded VelaError → canonical exception frame with code + message', async () => {
    @WebSocketGateway({ path: '/vela' })
    class VelaGateway {
      @SubscribeMessage('act')
      onAct() {
        throw new VelaError('forbidden', { message: 'room is locked' });
      }
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [VelaGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const client = new FakeClient();
    await app.get(WsDispatcher).dispatchMessage('/vela', client, frame('act', {}, '1'));

    expect(client.sent).toEqual([
      { event: 'exception', data: { code: 'forbidden', message: 'room is locked' }, id: '1' },
    ]);
  });

  it('unbranded Error → redacted internal frame; raw message only via report', async () => {
    @WebSocketGateway({ path: '/raw' })
    class RawGateway {
      @SubscribeMessage('act')
      onAct() {
        throw new Error('ws secret');
      }
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [RawGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const client = new FakeClient();
    await app.get(WsDispatcher).dispatchMessage('/raw', client, frame('act', {}, '2'));

    expect(client.sent).toEqual([
      { event: 'exception', data: { code: 'internal', message: 'Internal Server Error' }, id: '2' },
    ]);
    // Raw message never echoed to the client...
    expect(JSON.stringify(client.sent)).not.toContain('ws secret');
    // ...it surfaces ONLY through the reporter (default reporter → console.error).
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const reported = errorSpy.mock.calls[0][1];
    expect(reported).toBeInstanceOf(Error);
    expect(reported.message).toBe('ws secret');
  });

  it('WsException string payload → { message } frame (unchanged)', async () => {
    @WebSocketGateway({ path: '/wsex' })
    class WsExGateway {
      @SubscribeMessage('act')
      onAct() {
        throw new WsException('custom text');
      }
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [WsExGateway] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const client = new FakeClient();
    await app.get(WsDispatcher).dispatchMessage('/wsex', client, frame('act', {}, '3'));

    expect(client.sent).toEqual([
      { event: 'exception', data: { message: 'custom text' }, id: '3' },
    ]);
  });

  it('reports the error before filtering, even when a filter silently claims it', async () => {
    @Catch()
    class SwallowFilter implements ExceptionFilter {
      catch(): void {
        // claims the error but sends nothing to the client
      }
    }
    @WebSocketGateway({ path: '/report-first' })
    class Gateway {
      @SubscribeMessage('act')
      @UseFilters(SwallowFilter)
      onAct() {
        throw new WsException('handled quietly');
      }
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [Gateway, SwallowFilter] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const client = new FakeClient();
    await app.get(WsDispatcher).dispatchMessage('/report-first', client, frame('act', {}, '4'));

    // The filter swallowed the client frame, but the reporter still saw it first.
    expect(client.sent).toEqual([]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('throwing exception filter → original + filter both reported, redacted frame', async () => {
    @Catch()
    class BoomFilter implements ExceptionFilter {
      catch(): never {
        throw new Error('filter blew up');
      }
    }
    @WebSocketGateway({ path: '/filter-throws' })
    class Gateway {
      @SubscribeMessage('act')
      @UseFilters(BoomFilter)
      onAct() {
        throw new Error('original ws');
      }
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [Gateway, BoomFilter] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const client = new FakeClient();
    await app.get(WsDispatcher).dispatchMessage('/filter-throws', client, frame('act', {}, '5'));

    // The filter blew up → fall through to the default redacted frame.
    expect(client.sent).toEqual([
      { event: 'exception', data: { code: 'internal', message: 'Internal Server Error' }, id: '5' },
    ]);
    // Report FIRST always: the original error + the exception-filter-threw report.
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // Observability gap (whole-branch review): a reserved (`$…`) event handler
  // throwing was swallowed by handleError with a bare console.warn — a custom
  // APP_EXCEPTION_HANDLER never saw it. handleError now routes through the shared
  // reporter (default reporter → console.error). This path deliberately sends NO
  // client frame (reserved frames own their own responses).
  // ---------------------------------------------------------------------------
  it('reserved-event handler throwing → routed through the reporter, NO client frame sent', async () => {
    @ReservedWsEvent('$boom')
    @Injectable()
    class BoomReserved implements ReservedWsEventHandler {
      async handleReservedEvent(): Promise<void> {
        throw new Error('reserved boom');
      }
    }

    @WebSocketGateway({ path: '/g' })
    class Gateway {
      @SubscribeMessage('noop')
      onNoop() {}
    }

    @Module({ imports: [WebSocketModule.forRoot()], providers: [Gateway, BoomReserved] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const client = new FakeClient();

    await app.get(WsDispatcher).dispatchMessage('/g', client, frame('$boom', {}, 'r1'));

    // Deliberately no client frame for the reserved-frame error path.
    expect(client.sent).toEqual([]);
    // Routed through the reporter (default reporter → console.error).
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const reported = errorSpy.mock.calls[0][1] as Error;
    expect(reported).toBeInstanceOf(Error);
    expect(reported.message).toBe('reserved boom');
  });
});
