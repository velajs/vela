import { Container } from '../container/container';
import { Inject, Injectable, Optional } from '../container/decorators';
import type { Token, Type } from '../container/types';
import { instantiateMany } from '../http/instantiate';
import { RouteManager } from '../http/route.manager';
import type { OnApplicationBootstrap } from '../lifecycle/index';
import { ComponentManager } from '../pipeline/component.manager';
import { shouldFilterCatch } from '../pipeline/decorators';
import type {
  CanActivate,
  ExceptionFilter,
  NestInterceptor,
  PipeTransform,
} from '../pipeline/types';
import { MetadataRegistry } from '../registry/metadata.registry';
import type {
  Constructor,
  FilterType,
  GuardType,
  InterceptorType,
  ParameterMetadata,
  PipeType,
} from '../registry/types';
import { resolveWsArgs } from './ws-argument-resolver';
import { buildWsExecutionContext } from './ws-execution-context';
import { toErrorFrame, WsException } from './ws-exception';
import { WS_GATEWAY_METADATA, WS_SERVER, WS_SUBSCRIBE_METADATA } from './websocket.tokens';
import type {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessageMetadata,
  WebSocketGatewayOptions,
  WsClient,
  WsExecutionContext,
  WsMessage,
  WsResponse,
  WsServer,
} from './websocket.types';

interface HandlerEntry {
  methodName: string;
  paramMeta: ParameterMetadata[];
  paramTypes?: unknown[];
  guards: GuardType[];
  pipes: PipeType[];
  interceptors: InterceptorType[];
  filters: FilterType[];
}

interface GatewayEntry {
  path: string;
  instance: Record<string, unknown>;
  gatewayClass: Type;
  handlers: Map<string, HandlerEntry>;
}

function hasAfterInit(x: unknown): x is OnGatewayInit {
  return typeof (x as OnGatewayInit)?.afterInit === 'function';
}
function hasHandleConnection(x: unknown): x is OnGatewayConnection {
  return typeof (x as OnGatewayConnection)?.handleConnection === 'function';
}
function hasHandleDisconnect(x: unknown): x is OnGatewayDisconnect {
  return typeof (x as OnGatewayDisconnect)?.handleDisconnect === 'function';
}
function isWsResponse(x: unknown): x is WsResponse {
  return typeof x === 'object' && x !== null && typeof (x as WsResponse).event === 'string';
}

/**
 * Discovers `@WebSocketGateway` classes at bootstrap (same `container.getTokens()`
 * scan as `EventEmitterSubscriber` / `ScheduleRegistry`) and routes inbound
 * messages to `@SubscribeMessage` handlers. Transports call `handleOpen`,
 * `dispatchMessage`, `handleClose`, and `handleError`; the guard → pipe →
 * interceptor → filter pipeline (including `APP_*` global components) is reused
 * from `ComponentManager`.
 */
@Injectable()
export class WsDispatcher implements OnApplicationBootstrap {
  private readonly gateways = new Map<string, GatewayEntry>();

  constructor(
    @Inject(Container) private readonly container: Container,
    @Optional() @Inject(WS_SERVER) private readonly server?: WsServer,
    @Optional() @Inject(RouteManager) private readonly routeManager?: RouteManager,
  ) {}

  /** Paths of every discovered `@WebSocketGateway` — used by transports to register routes. */
  get gatewayPaths(): string[] {
    return [...this.gateways.keys()];
  }

  async onApplicationBootstrap(): Promise<void> {
    for (const token of this.container.getTokens()) {
      if (typeof token !== 'function') continue;
      const options = MetadataRegistry.getCustomClassMeta(token, WS_GATEWAY_METADATA) as
        | WebSocketGatewayOptions
        | undefined;
      if (!options) continue;

      const instance = this.resolveGateway(token);
      if (!instance) continue;

      const entry = this.buildGatewayEntry(token as Type, options, instance);

      // Two gateways on the same path (or both defaulting to '') would silently
      // overwrite each other in the routing Map — surface it instead.
      if (this.gateways.has(entry.path)) {
        const msg =
          `[vela] duplicate @WebSocketGateway path '${entry.path}' ` +
          `(${(token as Type).name}); keeping the first. Give each gateway a distinct path.`;
        if (this.container.getDiagnostics() === 'throw') throw new Error(msg);
        console.warn(msg);
        continue;
      }
      this.gateways.set(entry.path, entry);

      if (this.server && hasAfterInit(instance)) {
        try {
          await instance.afterInit(this.server);
        } catch (err) {
          this.reportBootstrapError((token as Type).name, err);
        }
      }
    }
  }

  async handleOpen(path: string, client: WsClient): Promise<void> {
    const entry = this.gateways.get(path);
    if (entry && hasHandleConnection(entry.instance)) {
      await entry.instance.handleConnection(client);
    }
  }

  async handleClose(path: string, client: WsClient, _code: number, _reason: string): Promise<void> {
    const entry = this.gateways.get(path);
    if (entry && hasHandleDisconnect(entry.instance)) {
      await entry.instance.handleDisconnect(client);
    }
  }

  async handleError(path: string, _client: WsClient, err: unknown): Promise<void> {
    if (this.container.getDiagnostics() !== 'silent') {
      console.warn(`[vela] websocket error on gateway ${path}:`, err);
    }
  }

  async dispatchMessage(path: string, client: WsClient, raw: string | ArrayBuffer): Promise<void> {
    const entry = this.gateways.get(path);
    if (!entry) return;

    let message: WsMessage;
    try {
      message = this.parse(raw);
    } catch {
      this.trySend(client, 'exception', { message: 'Invalid message' });
      return;
    }

    const handler = entry.handlers.get(message.event);
    if (!handler) return; // unknown event — ignored (NestJS parity)

    const ctx = buildWsExecutionContext(
      client,
      message.data,
      entry.gatewayClass,
      handler.methodName,
      message.event,
    );

    // App-wide global components (APP_* provider tokens + imperative
    // app.useGlobalX()) run first, then controller/handler-tier — mirroring the
    // HTTP HandlerExecutor so global guards/pipes/interceptors/filters protect
    // gateway messages too. Read live so late registrations propagate.
    const globals = this.routeManager?.getGlobalComponents();
    const guards = [
      ...instantiateMany<CanActivate>(globals?.guards ?? [], this.container),
      ...instantiateMany<CanActivate>(handler.guards, this.container),
    ];
    const pipes = [
      ...instantiateMany<PipeTransform>(globals?.pipes ?? [], this.container),
      ...instantiateMany<PipeTransform>(handler.pipes, this.container),
    ];
    const interceptors = [
      ...instantiateMany<NestInterceptor>(globals?.interceptors ?? [], this.container),
      ...instantiateMany<NestInterceptor>(handler.interceptors, this.container),
    ];
    // Handler/controller filters first (closest), then global filters last.
    const filters = [
      ...instantiateMany<ExceptionFilter>(handler.filters, this.container),
      ...instantiateMany<ExceptionFilter>(globals?.filters ?? [], this.container),
    ];

    try {
      for (const guard of guards) {
        if (!(await guard.canActivate(ctx))) {
          throw new WsException('Forbidden');
        }
      }

      const args = await resolveWsArgs(handler.paramMeta, client, message.data, pipes, handler.paramTypes);
      const method = entry.instance[handler.methodName] as (...a: unknown[]) => unknown;
      const core = async () => method.apply(entry.instance, args);
      const result = await ComponentManager.runInterceptorChain(interceptors, ctx, core);

      this.reply(client, message, result);
    } catch (error) {
      await this.runFilters(client, message, error, filters, ctx);
    }
  }

  private reply(client: WsClient, message: WsMessage, result: unknown): void {
    if (result === undefined || result === null) return;
    if (isWsResponse(result)) {
      this.trySend(client, result.event, result.data, message.id);
    } else {
      this.trySend(client, message.event, result, message.id);
    }
  }

  private async runFilters(
    client: WsClient,
    message: WsMessage,
    error: unknown,
    filters: ExceptionFilter[],
    ctx: WsExecutionContext,
  ): Promise<void> {
    for (const filter of filters) {
      if (shouldFilterCatch(filter, error)) {
        try {
          const handled = await filter.catch(error, ctx);
          if (isWsResponse(handled)) {
            this.trySend(client, handled.event, handled.data, message.id);
          }
        } catch {
          // A throwing filter falls back to the default error frame (mirrors HandlerExecutor).
          const frame = toErrorFrame(error);
          this.trySend(client, frame.event, frame.data, message.id);
        }
        return;
      }
    }
    const errorFrame = toErrorFrame(error);
    this.trySend(client, errorFrame.event, errorFrame.data, message.id);
  }

  // Outbound sends are best-effort: the socket may have closed mid-dispatch.
  private trySend(client: WsClient, event: string, data: unknown, id?: string): void {
    try {
      client.send(event, data, id);
    } catch {
      // socket closed — nothing to do
    }
  }

  private reportBootstrapError(name: string, err: unknown): void {
    const mode = this.container.getDiagnostics();
    if (mode === 'throw') throw err;
    if (mode === 'log') console.warn(`[vela] websocket gateway ${name} afterInit failed:`, err);
  }

  private parse(raw: string | ArrayBuffer): WsMessage {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const parsed = JSON.parse(text) as WsMessage;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.event !== 'string') {
      throw new Error('Invalid WebSocket message envelope');
    }
    return parsed;
  }

  private resolveGateway(token: Token): Record<string, unknown> | undefined {
    try {
      return this.container.resolve(token) as Record<string, unknown>;
    } catch (err) {
      const mode = this.container.getDiagnostics();
      if (mode === 'throw') throw err;
      if (mode === 'log') {
        const name = typeof token === 'function' ? token.name : String(token);
        console.warn(`[vela] websocket gateway discovery: cannot resolve ${name}:`, err);
      }
      return undefined;
    }
  }

  private buildGatewayEntry(
    gatewayClass: Type,
    options: WebSocketGatewayOptions,
    instance: Record<string, unknown>,
  ): GatewayEntry {
    const ctor = gatewayClass as unknown as Constructor;
    const subs =
      (MetadataRegistry.getCustomClassMeta(ctor, WS_SUBSCRIBE_METADATA) as
        | SubscribeMessageMetadata[]
        | undefined) ?? [];
    const allParams = MetadataRegistry.getParameters(ctor);

    const handlers = new Map<string, HandlerEntry>();
    for (const { event, methodName } of subs) {
      const paramMeta = [...(allParams.get(methodName) ?? [])].sort((a, b) => a.index - b.index);
      const paramTypes = Reflect.getMetadata('design:paramtypes', gatewayClass.prototype, methodName) as
        | unknown[]
        | undefined;

      handlers.set(event, {
        methodName,
        paramMeta,
        paramTypes,
        guards: ComponentManager.getComponents('guard', ctor, methodName),
        pipes: ComponentManager.getComponents('pipe', ctor, methodName),
        interceptors: ComponentManager.getComponents('interceptor', ctor, methodName),
        // Handler → controller → global, so the closest filter runs first (mirrors HandlerExecutor).
        filters: [...ComponentManager.getComponents('filter', ctor, methodName)].reverse(),
      });
    }

    return { path: options.path ?? '', instance, gatewayClass, handlers };
  }
}
