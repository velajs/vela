import { WsMessageQueue } from './ws-message-queue';
import { WebSocketSendGate, readWebSocketEnvelope } from '@velajs/live-protocol';
import { Scope } from '../constants';
import { runInEntrypointScope } from '../entrypoint/execution-scope';
import { resolveEntrypoint } from '../entrypoint/execution-context';
import { Container } from '../container/container';
import { Inject, Injectable, Optional } from '../container/decorators';
import type { Type } from '../container/types';
import { DiscoveryService } from '../discovery/discovery.service';
import type { ContributesEntrypoints, Entrypoint } from '../entrypoint/entrypoint.types';
import { resolveErrorReporter, type ErrorReporter } from '../exceptions/reporter';
import { instantiateManyAsync } from '../http/instantiate';
import { RouteManager } from '../http/route.manager';
import type { OnApplicationBootstrap } from '../lifecycle/index';
import { shouldFilterCatch } from '../pipeline/decorators';
import { PipelineRunner } from '../pipeline/pipeline-runner';
import { getScopedComponents } from '../pipeline/scoped-components';
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
import { shouldWarnProductionSecurity } from '../http/security-options';
import { resolveWsArgs } from './ws-argument-resolver';
import { buildWsExecutionContext } from './ws-execution-context';
import {
  normalizeWebSocketUpgradeIdentity,
  resolveGatewayRoomParam,
  resolveMaxFrameBytes,
  webSocketFrameFits,
} from './gateway-routing';
import { toErrorFrame, WsException } from './ws-exception';
import {
  RESERVED_WS_EVENT_PREFIX,
  WS_GATEWAY_METADATA,
  WS_RESERVED_METADATA,
  WS_SERVER,
  WS_SUBSCRIBE_METADATA,
} from './websocket.tokens';
import type {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ReservedWsEventHandler,
  ReservedWsEventMetadata,
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
  options: WebSocketGatewayOptions;
  maxFrameBytes: number;
  instance: unknown;
  gatewayClass: Type;
  moduleId: string;
  handlers: Map<string, HandlerEntry>;
}

interface ReservedEntry {
  token: Type;
  moduleId: string;
}

const HEARTBEAT_PING_EVENT = '$ping';
const HEARTBEAT_PONG_EVENT = '$pong';

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

/** Metadata carried by each `'websocket'` entrypoint a transport consumes. */
export interface WsEntrypointMeta {
  /** The gateway's route path (from `@WebSocketGateway({ path })`). */
  path: string;
  /** The dispatcher that routes frames for this gateway. */
  dispatcher: WsDispatcher;
  /** Validated gateway routing and upgrade policy. */
  options: WebSocketGatewayOptions;
  /** Stable container module bucket that declares the gateway. */
  moduleId: string;
}

/** Recover gateway metadata from its owning dispatcher, rather than trusting
 * arbitrary option objects contributed under the open "websocket" kind. */
export function readWsEntrypointMeta(value: unknown): WsEntrypointMeta {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('path' in value) ||
    typeof value.path !== 'string' ||
    !('dispatcher' in value) ||
    !(value.dispatcher instanceof WsDispatcher)
  ) {
    throw new Error('Invalid WebSocket entrypoint metadata.');
  }
  const entry = value.dispatcher
    .collectEntrypoints()
    .find((candidate) => candidate.meta.path === value.path);
  if (!entry)
    throw new Error(`WebSocket entrypoint path '${value.path}' is not owned by its dispatcher.`);
  return entry.meta;
}

/**
 * Discovers `@WebSocketGateway` classes at bootstrap (via `DiscoveryService`)
 * and routes inbound messages to `@SubscribeMessage` handlers. Transports read
 * the gateways from `app.entrypoints.ofKind('websocket')` (this dispatcher
 * contributes them) and call `handleOpen`, `dispatchMessage`, `handleClose`,
 * and `handleError`; the guard → pipe → interceptor → filter pipeline
 * (including `APP_*` global components) runs through the shared
 * `PipelineRunner`.
 */
@Injectable()
export class WsDispatcher implements OnApplicationBootstrap, ContributesEntrypoints {
  readonly #gateways = new Map<string, GatewayEntry>();
  readonly #reserved = new Map<string, ReservedEntry>();

  readonly #initializing = new WeakMap<object, Promise<void>>();
  readonly #container: Container;
  readonly #discovery: DiscoveryService;
  readonly #server?: WsServer;
  readonly #routeManager?: RouteManager;

  constructor(
    @Inject(Container) container: Container,
    @Inject(DiscoveryService) discovery: DiscoveryService,
    @Optional() @Inject(WS_SERVER) server?: WsServer,
    @Optional() @Inject(RouteManager) routeManager?: RouteManager,
  ) {
    this.#container = container;
    this.#discovery = discovery;
    this.#server = server;
    this.#routeManager = routeManager;
  }

  /** Paths of every discovered `@WebSocketGateway` — used by transports to register routes. */
  get gatewayPaths(): string[] {
    return [...this.#gateways.keys()];
  }

  /** Validated per-gateway frame ceiling used by runtime transports. */
  getGatewayMaxFrameBytes(path: string): number | undefined {
    return this.#gateways.get(path)?.maxFrameBytes;
  }

  /** Largest explicitly configured gateway ceiling for cross-instance buses. */
  getMaximumGatewayFrameBytes(): number {
    let maximum: number | undefined;
    for (const entry of this.#gateways.values()) {
      maximum =
        maximum === undefined ? entry.maxFrameBytes : Math.max(maximum, entry.maxFrameBytes);
    }
    return maximum ?? resolveMaxFrameBytes({});
  }

  async onApplicationBootstrap(): Promise<void> {
    // Reserved-event handlers first: modules claiming a `$…` event
    // (@ReservedWsEvent) receive those frames across every gateway path.
    for (const found of this.#discovery.registrationsWithMeta<ReservedWsEventMetadata>(
      WS_RESERVED_METADATA,
      { metadataOnly: true },
    )) {
      const event = found.meta.event;
      if (this.#reserved.get(event)?.token === found.metatype) {
        throw new Error(
          `[vela] ambiguous @ReservedWsEvent('${event}') registration across module owners`,
        );
      }
      if (this.#reserved.has(event)) {
        const msg =
          `[vela] duplicate @ReservedWsEvent('${event}') ` +
          `(${found.metatype.name}); keeping the first.`;
        if (this.#container.getDiagnostics() === 'throw') throw new Error(msg);
        console.warn(msg);
        continue;
      }
      this.#reserved.set(event, {
        token: found.metatype,
        moduleId: found.moduleId,
      });
    }

    for (const found of this.#discovery.registrationsWithMeta<WebSocketGatewayOptions>(
      WS_GATEWAY_METADATA,
      { metadataOnly: true },
    )) {
      const gatewayClass = found.metatype;
      const instance =
        found.scope === Scope.DEFAULT && !this.#container.isLazyPending(found.token, found.moduleId)
          ? await resolveEntrypoint(this.#container, {
              token: found.metatype,
              moduleId: found.moduleId,
            })
          : undefined;

      const entry = this.buildGatewayEntry(gatewayClass, found.meta, instance, found.moduleId);

      // Two gateways on the same path (or both defaulting to '') would silently
      // overwrite each other in the routing Map — surface it instead.
      if (this.#gateways.get(entry.path)?.gatewayClass === gatewayClass) {
        throw new Error(
          `[vela] ambiguous @WebSocketGateway path '${entry.path}' registration across module owners`,
        );
      }
      if (this.#gateways.has(entry.path)) {
        const msg =
          `[vela] duplicate @WebSocketGateway path '${entry.path}' ` +
          `(${gatewayClass.name}); keeping the first. Give each gateway a distinct path.`;
        if (this.#container.getDiagnostics() === 'throw') throw new Error(msg);
        console.warn(msg);
        continue;
      }
      this.#gateways.set(entry.path, entry);
      this.#server?.setOutboundFrameLimit?.(entry.maxFrameBytes);

      if (this.#server && hasAfterInit(instance)) {
        try {
          await this.initializeGateway(instance);
        } catch (err) {
          this.reportBootstrapError(gatewayClass.name, err);
        }
      }
    }
  }

  /** One `'websocket'` entrypoint per discovered gateway (authoritative). */
  collectEntrypoints(): Entrypoint<WsEntrypointMeta>[] {
    return [...this.#gateways.values()].map((entry) => ({
      kind: 'websocket',
      token: entry.gatewayClass,
      moduleId: entry.moduleId,
      instance: entry.instance,
      meta: {
        path: entry.path,
        dispatcher: this,
        options: entry.options,
        moduleId: entry.moduleId,
      },
    }));
  }

  private async initializeGateway(instance: OnGatewayInit): Promise<void> {
    if (!this.#server) return;
    let pending = this.#initializing.get(instance);
    if (!pending) {
      const server = this.#server;
      pending = Promise.resolve().then(() => instance.afterInit(server));
      this.#initializing.set(instance, pending);
    }
    await pending;
  }

  private async resolveGateway(scope: Container, entry: GatewayEntry): Promise<unknown> {
    const instance = await resolveEntrypoint(scope, {
      token: entry.gatewayClass,
      moduleId: entry.moduleId,
    });
    if (hasAfterInit(instance)) await this.initializeGateway(instance);
    return instance;
  }

  async handleOpen(path: string, client: WsClient): Promise<void> {
    const entry = this.#gateways.get(path);
    if (!entry) return;
    await runInEntrypointScope(this.#container, async (scope) => {
      const instance = await this.resolveGateway(scope, entry);
      if (hasHandleConnection(instance)) await instance.handleConnection(client);
    });
  }

  async handleClose(path: string, client: WsClient, _code: number, _reason: string): Promise<void> {
    for (const target of this.#reserved.values()) {
      try {
        await runInEntrypointScope(this.#container, async (scope) => {
          const handler = await this.resolveReserved(scope, target);
          await handler.handleSocketClose?.(path, client);
        });
      } catch (err) {
        await this.handleError(path, client, err);
      }
    }
    const entry = this.#gateways.get(path);
    if (!entry) return;
    await runInEntrypointScope(this.#container, async (scope) => {
      const instance = await this.resolveGateway(scope, entry);
      if (hasHandleDisconnect(instance)) await instance.handleDisconnect(client);
    });
  }

  private async resolveReserved(
    scope: Container,
    target: ReservedEntry,
  ): Promise<ReservedWsEventHandler> {
    const handler = await resolveEntrypoint(scope, target);
    if (
      !handler ||
      typeof handler !== 'object' ||
      !('handleReservedEvent' in handler) ||
      typeof handler.handleReservedEvent !== 'function'
    ) {
      throw new TypeError('Reserved WebSocket provider must implement handleReservedEvent');
    }
    return handler as ReservedWsEventHandler;
  }

  async handleError(path: string, _client: WsClient, err: unknown): Promise<void> {
    // Connection-level and reserved-frame (`$…`) throws land here. Route them
    // through the shared reporter so a custom APP_EXCEPTION_HANDLER observes
    // them too — the default reporter console.errors and honors `'silent'`.
    // No client frame is sent for this path, by design: reserved frames own
    // their own client-facing responses, and there is no envelope id to reply to.
    resolveErrorReporter(this.#container).report(err, {
      edge: 'ws',
      source: path ? `reserved-frame ${path}` : 'reserved-frame',
    });
  }

  /** Re-run app-wide and gateway delivery authorization for one push recipient. */
  async authorizeDelivery(
    path: string,
    client: WsClient,
    invocationScope?: Container,
  ): Promise<boolean> {
    const entry = this.#gateways.get(path);
    if (!entry) return false;
    if (normalizeWebSocketUpgradeIdentity(client.data) === false) {
      try {
        client.close(1008, 'identity invalid or expired');
      } catch {
        // already closed
      }
      return false;
    }

    try {
      const authorize = async (scope: Container): Promise<boolean> => {
        const context = buildWsExecutionContext(
          client,
          undefined,
          entry.gatewayClass,
          '__delivery__',
          '$delivery',
          entry.moduleId,
          scope,
        );
        const globals = this.#routeManager?.getGlobalComponents();
        const guards = await instantiateManyAsync<CanActivate>(globals?.guards ?? [], scope);
        for (const guard of guards) if (!(await guard.canActivate(context))) return false;
        return (
          !entry.options.authorizeDelivery ||
          (await entry.options.authorizeDelivery(client)) === true
        );
      };
      return invocationScope
        ? await authorize(invocationScope)
        : await runInEntrypointScope(this.#container, authorize);
    } catch {
      return false;
    }
  }

  async dispatchMessage(path: string, client: WsClient, raw: string | ArrayBuffer): Promise<void> {
    const entry = this.#gateways.get(path);
    if (!entry) return;

    if (normalizeWebSocketUpgradeIdentity(client.data) === false) {
      try {
        client.close(1008, 'identity invalid or expired');
      } catch {
        // already closed
      }
      return;
    }

    if (!this.frameFits(raw, entry.maxFrameBytes)) {
      try {
        client.close(1009, 'Message too large');
      } catch {
        // already closed
      }
      return;
    }

    let message: WsMessage;
    try {
      message = this.parse(raw);
    } catch {
      this.trySend(client, entry.maxFrameBytes, 'exception', { message: 'Invalid message' });
      return;
    }

    // Framework heartbeat: transport-independent and deliberately outside the
    // application pipeline. The `$` namespace makes it impossible for an app
    // gateway to collide with this liveness exchange; Cloudflare intercepts
    // the same exact pair before waking a hibernated Durable Object.
    if (message.event === HEARTBEAT_PING_EVENT) {
      this.trySend(client, entry.maxFrameBytes, HEARTBEAT_PONG_EVENT, undefined);
      return;
    }

    // Reserved namespace: `$…` frames route to @ReservedWsEvent handlers
    // (after app-wide guards) and NEVER reach gateway handlers; an unclaimed
    // reserved event is dropped like any unknown event.
    if (message.event.startsWith(RESERVED_WS_EVENT_PREFIX)) {
      await this.dispatchReserved(path, client, message);
      return;
    }

    const handler = entry.handlers.get(message.event);
    if (!handler) return; // unknown event — ignored (NestJS parity)

    try {
      await runInEntrypointScope(this.#container, async (scope) => {
        const ctx = buildWsExecutionContext(
          client,
          message.data,
          entry.gatewayClass,
          handler.methodName,
          message.event,
          entry.moduleId,
          scope,
        );
        const globals = this.#routeManager?.getGlobalComponents();
        let filters: ExceptionFilter[] = [];
        try {
          filters = [
            ...(await instantiateManyAsync<ExceptionFilter>(
              handler.filters,
              scope,
              entry.moduleId,
            )),
            ...(await instantiateManyAsync<ExceptionFilter>(globals?.filters ?? [], scope)),
          ];
          const guards = [
            ...(await instantiateManyAsync<CanActivate>(globals?.guards ?? [], scope)),
            ...(await instantiateManyAsync<CanActivate>(handler.guards, scope, entry.moduleId)),
          ];
          const result = await PipelineRunner.run({
            context: ctx,
            guards,
            // Resolve remaining components after guards have admitted this invocation.
            resolveArgs: async () => {
              const pipes = [
                ...(await instantiateManyAsync<PipeTransform>(globals?.pipes ?? [], scope)),
                ...(await instantiateManyAsync<PipeTransform>(
                  handler.pipes,
                  scope,
                  entry.moduleId,
                )),
              ];
              return resolveWsArgs(
                handler.paramMeta,
                client,
                message.data,
                pipes,
                handler.paramTypes,
              );
            },
            interceptors: [],
            invoke: async (args) => {
              const interceptors = [
                ...(await instantiateManyAsync<NestInterceptor>(
                  globals?.interceptors ?? [],
                  scope,
                )),
                ...(await instantiateManyAsync<NestInterceptor>(
                  handler.interceptors,
                  scope,
                  entry.moduleId,
                )),
              ];
              return PipelineRunner.chainInterceptors(interceptors, ctx, async () => {
                const instance = await this.resolveGateway(scope, entry);
                if (!instance || typeof instance !== 'object')
                  throw new TypeError('Invalid WebSocket gateway instance');
                const method: unknown = Reflect.get(instance, handler.methodName);
                if (typeof method !== 'function') throw new TypeError('Invalid WebSocket handler');
                return Reflect.apply(method, instance, args);
              });
            },
            onGuardReject: () => new WsException('Forbidden'),
          });
          this.reply(client, message, result, entry.maxFrameBytes);
        } catch (error) {
          const reporter = resolveErrorReporter(scope);
          const source = `${entry.gatewayClass.name}.${handler.methodName}`;
          reporter.report(error, { edge: 'ws', source });
          await this.runFilters(
            client,
            message,
            error,
            filters,
            ctx,
            reporter,
            source,
            entry.maxFrameBytes,
          );
        }
      });
    } catch (error) {
      // Managed background work/disposal can fail after the handler's response.
      await this.handleError(path, client, error);
    }
  }

  /**
   * Route a reserved (`$…`) frame to its claiming handler. App-wide (`APP_*` /
   * `useGlobalGuards`) guards protect reserved frames exactly like gateway
   * messages — guards-first, WS convention; handler/class-tier components are
   * the claiming module's own concern (e.g. live resolvers run their scoped
   * guards at subscribe).
   */
  private async dispatchReserved(
    path: string,
    client: WsClient,
    message: WsMessage,
  ): Promise<void> {
    const reserved = this.#reserved.get(message.event);
    if (!reserved) return;
    const { token, moduleId } = reserved;
    const maxFrameBytes = this.#gateways.get(path)?.maxFrameBytes ?? resolveMaxFrameBytes({});
    try {
      await runInEntrypointScope(this.#container, async (scope) => {
        const ctx = buildWsExecutionContext(
          client,
          message.data,
          token,
          'handleReservedEvent',
          message.event,
          moduleId,
          scope,
        );
        const globals = this.#routeManager?.getGlobalComponents();
        const guards = await instantiateManyAsync<CanActivate>(globals?.guards ?? [], scope);
        for (const guard of guards) {
          if (!(await guard.canActivate(ctx))) {
            const frame = toErrorFrame(
              new WsException('Forbidden'),
              resolveErrorReporter(scope).catalog,
            );
            this.trySend(client, maxFrameBytes, frame.event, frame.data, message.id);
            return;
          }
        }
        const handler = await this.resolveReserved(scope, reserved);
        await handler.handleReservedEvent(path, client, message, ctx);
      });
    } catch (err) {
      await this.handleError(path, client, err);
    }
  }

  private reply(
    client: WsClient,
    message: WsMessage,
    result: unknown,
    maxFrameBytes: number,
  ): void {
    if (result === undefined || result === null) return;
    if (isWsResponse(result)) {
      this.trySend(client, maxFrameBytes, result.event, result.data, message.id);
    } else {
      this.trySend(client, maxFrameBytes, message.event, result, message.id);
    }
  }

  private async runFilters(
    client: WsClient,
    message: WsMessage,
    error: unknown,
    filters: ExceptionFilter[],
    ctx: WsExecutionContext,
    reporter: ErrorReporter,
    source: string,
    maxFrameBytes: number,
  ): Promise<void> {
    for (const filter of filters) {
      if (shouldFilterCatch(filter, error)) {
        try {
          const handled = await filter.catch(error, ctx);
          if (isWsResponse(handled)) {
            this.trySend(client, maxFrameBytes, handled.event, handled.data, message.id);
          }
        } catch (filterError) {
          // A throwing filter is itself a bug worth reporting — then fall back
          // to the default redacted frame (mirrors HandlerExecutor).
          reporter.report(filterError, { edge: 'ws', source, note: 'exception filter threw' });
          const frame = toErrorFrame(error, reporter.catalog);
          this.trySend(client, maxFrameBytes, frame.event, frame.data, message.id);
        }
        return;
      }
    }
    const errorFrame = toErrorFrame(error, reporter.catalog);
    this.trySend(client, maxFrameBytes, errorFrame.event, errorFrame.data, message.id);
  }

  // Outbound sends are best-effort: the socket may have closed mid-dispatch.
  private trySend(
    client: WsClient,
    maxFrameBytes: number,
    event: string,
    data: unknown,
    id?: string,
  ): void {
    try {
      const frame = JSON.stringify(id !== undefined ? { id, event, data } : { event, data });
      if (!webSocketFrameFits(frame, maxFrameBytes)) {
        client.close(1009, 'Message too large');
        return;
      }
      client.send(event, data, id);
    } catch {
      // socket closed — nothing to do
    }
  }

  private reportBootstrapError(name: string, err: unknown): void {
    const mode = this.#container.getDiagnostics();
    if (mode === 'throw') throw err;
    if (mode === 'log') console.warn(`[vela] websocket gateway ${name} afterInit failed:`, err);
  }

  private parse(raw: string | ArrayBuffer): WsMessage {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const parsed = readWebSocketEnvelope(JSON.parse(text));
    if (!parsed) {
      throw new Error('Invalid WebSocket message envelope');
    }
    return parsed;
  }

  private frameFits(raw: string | ArrayBuffer, maxBytes: number): boolean {
    return webSocketFrameFits(raw, maxBytes);
  }

  private buildGatewayEntry(
    gatewayClass: Type,
    options: WebSocketGatewayOptions,
    instance: unknown,
    moduleId: string,
  ): GatewayEntry {
    // Validate security-sensitive routing at bootstrap rather than silently
    // collapsing rooms when a transport receives its first request.
    resolveGatewayRoomParam(options);
    new WebSocketSendGate(options.sendPolicy);
    new WsMessageQueue(() => {}, options.maxPendingMessages, options.maxPendingBytes);
    if (options.allowedOrigins === '*' && shouldWarnProductionSecurity()) {
      console.warn(
        `[vela] security warning: WebSocket gateway ${gatewayClass.name} allows every browser ` +
          'Origin; use an exact origin allowlist for credentialed/public deployments',
      );
    }
    const maxFrameBytes = resolveMaxFrameBytes(options);
    const ctor = gatewayClass as unknown as Constructor;
    const subs =
      (MetadataRegistry.getCustomClassMeta(ctor, WS_SUBSCRIBE_METADATA) as
        | SubscribeMessageMetadata[]
        | undefined) ?? [];
    const allParams = MetadataRegistry.getParameters(ctor);

    const handlers = new Map<string, HandlerEntry>();
    for (const { event, methodName } of subs) {
      // The `$` namespace belongs to framework modules (@ReservedWsEvent) — an
      // app gateway subscribing to it would never receive the frames anyway.
      if (event.startsWith(RESERVED_WS_EVENT_PREFIX)) {
        const msg =
          `[vela] @SubscribeMessage('${event}') on ${gatewayClass.name}: the ` +
          `'${RESERVED_WS_EVENT_PREFIX}' event prefix is reserved for framework modules — skipped.`;
        if (this.#container.getDiagnostics() === 'throw') throw new Error(msg);
        console.warn(msg);
        continue;
      }
      const paramMeta = [...(allParams.get(methodName) ?? [])].sort((a, b) => a.index - b.index);
      const paramTypes = Reflect.getMetadata(
        'design:paramtypes',
        gatewayClass.prototype,
        methodName,
      ) as unknown[] | undefined;

      const container = this.#container;
      handlers.set(event, {
        methodName,
        paramMeta,
        paramTypes,
        guards: getScopedComponents('guard', ctor, methodName, container, moduleId),
        pipes: getScopedComponents('pipe', ctor, methodName, container, moduleId),
        interceptors: getScopedComponents('interceptor', ctor, methodName, container, moduleId),
        // Handler → controller → global, so the closest filter runs first (mirrors HandlerExecutor).
        filters: getScopedComponents('filter', ctor, methodName, container, moduleId).toReversed(),
      });
    }

    return {
      path: options.path ?? '',
      options: { ...options },
      maxFrameBytes,
      instance,
      gatewayClass,
      moduleId,
      handlers,
    };
  }
}
