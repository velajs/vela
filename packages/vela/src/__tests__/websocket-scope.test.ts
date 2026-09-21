import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LIVE_PROTOCOL } from '@velajs/live-protocol';
import {
  Module,
  Injectable,
  Inject,
  InjectionToken,
  Scope,
  UseGuards,
  UsePipes,
  UseFilters,
  UseInterceptors,
  ValidationPipe,
  MetadataRegistry,
  VelaFactory,
  defineProvider,
  getExecutionLifetime,
} from '../index';
import type { CanActivate, ExecutionContext, Container, CallHandler } from '../index';
import {
  WebSocketGateway,
  WebSocketModule,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WsDispatcher,
  ReservedWsEvent,
} from '../websocket';
import type { WsClient, WsMessage, WsExecutionContext } from '../websocket';
import {
  LiveModule,
  LiveResolver,
  LiveQuery,
  LiveEngine,
  LiveInvalidation,
  defineLiveQuery,
} from '../live';

class Client implements WsClient {
  data: Record<string, unknown>;
  readonly rooms = new Set(['room']);
  readonly raw = null;
  readonly frames: unknown[] = [];
  constructor(readonly id: string) {
    this.data = {
      principal: { issuer: 'test', subject: id, principalType: 'user' },
      tenantId: id,
      expiresAtMs: Date.now() + 60000,
    };
  }
  send(event: string, data?: unknown, id?: string) {
    this.frames.push({ event, data, id });
  }
  sendRaw(payload: string) {
    this.frames.push(JSON.parse(payload));
  }
  join() {}
  leave() {}
  commit() {}
  close() {}
}
beforeEach(() => MetadataRegistry.clear());

describe('WebSocket invocation ownership', () => {
  it('shares a child across async guards and a request gateway; isolates overlapping tenants and drains before disposal', async () => {
    const disposed: string[] = [],
      deferred: string[] = [];
    const contexts: Container[] = [];
    let constructed = 0;
    @Injectable({ scope: Scope.REQUEST })
    class State {
      #owner = '';
      set(owner: string) {
        this.#owner = owner;
      }
      get() {
        return this.#owner;
      }
      dispose() {
        disposed.push(this.#owner);
      }
    }
    const VALUE = new InjectionToken<string>('async message value');
    @Injectable({ scope: Scope.REQUEST })
    class Guard implements CanActivate {
      #calls = 0;
      constructor(@Inject(State) readonly state: State) {}
      async canActivate(ctx: ExecutionContext) {
        expect(++this.#calls).toBe(1);
        const scope = ctx.getContainer()!;
        contexts.push(scope);
        this.state.set(ctx.switchToWs().getClient().id);
        getExecutionLifetime(scope)!.defer(async () => {
          deferred.push(this.state.get());
        });
        await Promise.resolve();
        return true;
      }
    }
    @WebSocketGateway({ path: '/scope' })
    @Injectable({ scope: Scope.REQUEST })
    @UseGuards(Guard)
    class Gateway {
      #calls = 0;
      constructor(
        @Inject(State) readonly state: State,
        @Inject(VALUE) readonly value: string,
      ) {
        constructed++;
      }
      @SubscribeMessage('go')
      async go(@ConnectedSocket() client: WsClient) {
        await Promise.resolve();
        return {
          tenant: this.state.get(),
          value: this.value,
          call: ++this.#calls,
          room: [...client.rooms][0],
        };
      }
    }
    @Module({
      imports: [WebSocketModule.forRoot()],
      providers: [
        State,
        Guard,
        Gateway,
        defineProvider(VALUE, {
          scope: Scope.REQUEST,
          useFactory: async () => {
            await Promise.resolve();
            return 'async';
          },
        }),
      ],
    })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      expect(constructed).toBe(0);
      const clients = [new Client('a'), new Client('b')];
      await Promise.all(
        clients.map((client) =>
          app.get(WsDispatcher).dispatchMessage('/scope', client, '{"event":"go"}'),
        ),
      );
      expect(clients.map((client) => client.frames)).toEqual(
        clients.map((client) => [
          {
            event: 'go',
            id: undefined,
            data: { tenant: client.id, value: 'async', call: 1, room: 'room' },
          },
        ]),
      );
      expect(new Set(contexts).size).toBe(2);
      expect(contexts.every((scope) => scope !== app.getContainer())).toBe(true);
      expect(disposed.toSorted()).toEqual(['a', 'b']);
      expect(deferred.toSorted()).toEqual(['a', 'b']);
    } finally {
      await app.close();
    }
  });

  it('keeps shared component tokens in each gateway owner module', async () => {
    const OWNER = new InjectionToken<string>('owner');
    const seen: string[] = [];
    @Injectable({ scope: Scope.REQUEST })
    class Guard {
      constructor(@Inject(OWNER) readonly owner: string) {}
      canActivate() {
        seen.push(this.owner);
        return true;
      }
    }
    @WebSocketGateway({ path: '/a' })
    @UseGuards(Guard)
    class A {
      @SubscribeMessage('go') go() {
        return 'a';
      }
    }
    @WebSocketGateway({ path: '/b' })
    @UseGuards(Guard)
    class B {
      @SubscribeMessage('go') go() {
        return 'b';
      }
    }
    @Module({ providers: [A, Guard, defineProvider(OWNER, { useValue: 'a' })] })
    class Left {}
    @Module({ providers: [B, Guard, defineProvider(OWNER, { useValue: 'b' })] })
    class Right {}
    @Module({ imports: [WebSocketModule.forRoot(), Left, Right] })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      await app.get(WsDispatcher).dispatchMessage('/b', new Client('b'), '{"event":"go"}');
      await app.get(WsDispatcher).dispatchMessage('/a', new Client('a'), '{"event":"go"}');
      expect(seen).toEqual(['b', 'a']);
    } finally {
      await app.close();
    }
  });

  it('does not construct a request gateway rejected by its guard and disposes the guard', async () => {
    let constructions = 0,
      disposals = 0;
    @Injectable({ scope: Scope.REQUEST })
    class Deny {
      canActivate() {
        return false;
      }
      dispose() {
        disposals++;
      }
    }
    @WebSocketGateway({ path: '/denied' })
    @Injectable({ scope: Scope.REQUEST })
    @UseGuards(Deny)
    class Gateway {
      constructor() {
        constructions++;
      }
      @SubscribeMessage('go') go() {
        return 'bad';
      }
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [Deny, Gateway] })
    class App {}
    const app = await VelaFactory.create(App, { diagnostics: 'silent' });
    try {
      await app.get(WsDispatcher).dispatchMessage('/denied', new Client('a'), '{"event":"go"}');
      expect(constructions).toBe(0);
      expect(disposals).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('scopes reserved handlers while keeping connection data across messages', async () => {
    const calls: number[] = [];
    let disposed = 0;
    @ReservedWsEvent('$custom')
    @Injectable({ scope: Scope.REQUEST })
    class Handler {
      #calls = 0;
      handleReservedEvent(
        _path: string,
        client: WsClient,
        _message: WsMessage,
        context?: WsExecutionContext,
      ) {
        expect(context?.getContainer()).toBeDefined();
        client.data.count = Number(client.data.count ?? 0) + 1;
        calls.push(++this.#calls);
      }
      dispose() {
        disposed++;
      }
    }
    @WebSocketGateway({ path: '/ws' })
    class Gateway {}
    @Module({ imports: [WebSocketModule.forRoot()], providers: [Gateway, Handler] })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      const client = new Client('a');
      await app.get(WsDispatcher).dispatchMessage('/ws', client, '{"event":"$custom"}');
      await app.get(WsDispatcher).dispatchMessage('/ws', client, '{"event":"$custom"}');
      expect(calls).toEqual([1, 1]);
      expect(client.data.count).toBe(2);
      expect(disposed).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('discovers request live resolvers and shares their authorization state on subscribe and refresh', async () => {
    let disposed = 0;
    @Injectable({ scope: Scope.REQUEST })
    class State {
      #admitted = false;
      admit() {
        this.#admitted = true;
      }
      read() {
        return this.#admitted;
      }
      dispose() {
        disposed++;
      }
    }
    @Injectable({ scope: Scope.REQUEST })
    class Guard {
      constructor(@Inject(State) readonly state: State) {}
      canActivate(context: ExecutionContext) {
        expect(context.getContainer()).toBeDefined();
        this.state.admit();
        return true;
      }
    }
    @LiveResolver()
    @Injectable({ scope: Scope.REQUEST })
    @UseGuards(Guard)
    class Resolver {
      constructor(@Inject(State) readonly state: State) {}
      @LiveQuery('state', defineLiveQuery({ args: z.unknown(), result: z.boolean() }), {
        tags: ['state'],
      })
      stateQuery() {
        return this.state.read();
      }
    }
    @WebSocketGateway({ path: '/ws' })
    class Gateway {}
    @Module({
      imports: [WebSocketModule.forRoot(), LiveModule.forRoot()],
      providers: [State, Guard, Resolver, Gateway],
    })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      const client = new Client('a');
      await app.get(WsDispatcher).dispatchMessage(
        '/ws',
        client,
        JSON.stringify({
          event: '$live',
          data: { t: 'sub', sub: 's', query: 'state', v: LIVE_PROTOCOL },
        }),
      );
      expect(client.frames).toContainEqual(
        expect.objectContaining({ data: expect.objectContaining({ t: 'data', snapshot: true }) }),
      );
      await app.get(LiveInvalidation).invalidate({ tags: ['state'] });
      await app.get(LiveEngine).whenIdle();
      expect(disposed).toBe(2);
      expect(client.frames).toContainEqual(
        expect.objectContaining({ data: expect.objectContaining({ t: 'settled' }) }),
      );
    } finally {
      await app.close();
    }
  });
  it('runs async body validation once and keeps pipes, interceptors and filters in the admitted scope', async () => {
    let transforms = 0,
      disposals = 0;
    @Injectable({ scope: Scope.REQUEST })
    class State {
      admitted = false;
      dispose() {
        disposals++;
      }
    }
    @Injectable({ scope: Scope.REQUEST })
    class Guard {
      constructor(@Inject(State) readonly state: State) {}
      canActivate() {
        this.state.admitted = true;
        return true;
      }
    }
    @Injectable({ scope: Scope.REQUEST })
    class Pipe extends ValidationPipe {
      constructor(@Inject(State) state: State) {
        expect(state.admitted).toBe(true);
        super(
          z.string().transform(async (value) => {
            transforms++;
            await Promise.resolve();
            return value + '!';
          }),
        );
      }
    }
    @Injectable({ scope: Scope.REQUEST })
    class Interceptor {
      constructor(@Inject(State) readonly state: State) {}
      async intercept(context: ExecutionContext, next: CallHandler) {
        expect(this.state.admitted).toBe(true);
        expect(context.getContainer()).toBeDefined();
        return await next.handle();
      }
    }
    @Injectable({ scope: Scope.REQUEST })
    class Filter {
      constructor(@Inject(State) readonly state: State) {}
      catch() {
        return { event: 'caught', data: this.state.admitted };
      }
    }
    @WebSocketGateway({ path: '/pipeline' })
    @UseGuards(Guard)
    @UsePipes(Pipe)
    @UseInterceptors(Interceptor)
    @UseFilters(Filter)
    class Gateway {
      @SubscribeMessage('go') go(@MessageBody() body: string) {
        if (body === 'fail!') throw new Error('failure');
        return body;
      }
    }
    @Module({
      imports: [WebSocketModule.forRoot()],
      providers: [State, Guard, Pipe, Interceptor, Filter, Gateway],
    })
    class App {}
    const app = await VelaFactory.create(App, { diagnostics: 'silent' });
    try {
      const client = new Client('a');
      await app
        .get(WsDispatcher)
        .dispatchMessage('/pipeline', client, '{"event":"go","data":"ok"}');
      await app
        .get(WsDispatcher)
        .dispatchMessage('/pipeline', client, '{"event":"go","data":"fail"}');
      expect(client.frames).toEqual([
        { event: 'go', data: 'ok!', id: undefined },
        { event: 'caught', data: true, id: undefined },
      ]);
      expect(transforms).toBe(2);
      expect(disposals).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('gives connection and disconnect callbacks separate disposable gateway instances', async () => {
    let next = 0;
    const calls: string[] = [];
    @WebSocketGateway({ path: '/hooks' })
    @Injectable({ scope: Scope.REQUEST })
    class Gateway {
      #id = ++next;
      handleConnection(client: WsClient) {
        calls.push('open:' + this.#id);
        client.data.kept = true;
      }
      @SubscribeMessage('go') go(@ConnectedSocket() client: WsClient) {
        calls.push('message:' + this.#id);
        expect(client.data.kept).toBe(true);
      }
      handleDisconnect(client: WsClient) {
        calls.push('close:' + this.#id);
        expect(client.data.kept).toBe(true);
      }
      dispose() {
        calls.push('dispose:' + this.#id);
      }
    }
    @Module({ imports: [WebSocketModule.forRoot()], providers: [Gateway] })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      const client = new Client('a'),
        dispatcher = app.get(WsDispatcher);
      await dispatcher.handleOpen('/hooks', client);
      await dispatcher.dispatchMessage('/hooks', client, '{"event":"go"}');
      await dispatcher.handleClose('/hooks', client, 1000, 'done');
      expect(calls).toEqual([
        'open:1',
        'dispose:1',
        'message:2',
        'dispose:2',
        'close:3',
        'dispose:3',
      ]);
    } finally {
      await app.close();
    }
  });

  it('rejects a gateway registered under multiple owners instead of selecting one', async () => {
    @WebSocketGateway({ path: '/ambiguous' })
    class Gateway {}
    @Module({ providers: [Gateway] })
    class Left {}
    @Module({ providers: [Gateway] })
    class Right {}
    @Module({ imports: [WebSocketModule.forRoot(), Left, Right] })
    class App {}
    await expect(VelaFactory.create(App, { diagnostics: 'silent' })).rejects.toThrow(
      'ambiguous @WebSocketGateway',
    );
  });
});
