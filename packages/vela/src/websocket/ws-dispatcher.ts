import { WsMessageQueue } from './ws-message-queue';
import { WebSocketSendGate, readWebSocketEnvelope } from '@velajs/live-protocol';
import { Scope } from '../constants';
import { runInEntrypointScope } from '../entrypoint/execution-scope';
import { resolveEntrypoint } from '../entrypoint/execution-context';
import { Container } from '../container/container';
import { getConstructorMetadata, Inject, Injectable, Optional } from '../container/decorators';
import type { Type } from '../container/types';
import { DiscoveryService } from '../discovery/discovery.service';
import type { ContributesEntrypoints, Entrypoint } from '../entrypoint/entrypoint.types';
import { resolveErrorReporter, type ErrorReporter } from '../exceptions/reporter';
import { instantiateManyAsync } from '../http/instantiate';
import { RouteManager } from '../http/route.manager';
import type { OnApplicationBootstrap, OnModuleInit } from '../lifecycle/index';
import { shouldFilterCatch } from '../pipeline/decorators';
import { orderGuardsByPhase } from '../pipeline/guard-phase';
import { handlerFunction } from '../pipeline/handler-function';
import { PipelineRunner } from '../pipeline/pipeline-runner';
import { getScopedComponents } from '../pipeline/scoped-components';
import type {
  CanActivate,
  ExceptionFilter,
  NestInterceptor,
  PipeTransform,
} from '../pipeline/types';
import { classLineage, methodLineage } from '../registry/inherited-metadata';
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
import { gatewayServerOf, gatewayServerToken } from './ws-server';
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
  /** The gateway's own server, which `afterInit` receives. */
  server?: WsServer;
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
 * The `@SubscribeMessage` handlers of a gateway, each with the class that
 * declares it: its own, then those an ancestor class declares on a method the
 * gateway inherits unchanged, as Nest reads them from the prototype chain. The
 * nearest declaration of an event wins; an override the gateway does not
 * decorate is not a handler.
 */
function gatewaySubscriptions(
  type: Constructor,
): Array<{ event: string; methodName: string; owner: Constructor }> {
  const handled = new Set<string>();
  const subscriptions: Array<{ event: string; methodName: string; owner: Constructor }> = [];
  for (const owner of classLineage(type)) {
    const declared =
      (MetadataRegistry.getCustomClassMeta(owner, WS_SUBSCRIBE_METADATA) as
        | SubscribeMessageMetadata[]
        | undefined) ?? [];
    // Within one class the last declaration of an event wins.
    const own = new Map<string, string>();
    for (const { event, methodName } of declared) {
      if (handled.has(event)) continue;
      if (owner !== type && !methodLineage(type, methodName).includes(owner)) continue;
      own.set(event, methodName);
    }
    for (const [event, methodName] of own) {
      handled.add(event);
      subscriptions.push({ event, methodName, owner });
    }
  }
  return subscriptions;
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
export class WsDispatcher implements OnModuleInit, OnApplicationBootstrap, ContributesEntrypoints {
  readonly #gateways = new Map<string, GatewayEntry>();
  readonly #reserved = new Map<string, ReservedEntry>();

  readonly #initializing = new WeakMap<object, Promise<void>>();
  // Each gateway class's own server (`WsServer.forGateway`), built once.
  readonly #gatewayServers = new Map<Type, WsServer>();
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
    // Connect every gateway's @WebSocketServer() before any lifecycle hook
    // runs, so a gateway may push from its own hooks. The server behind it
    // is looked up on first use: a WS_SERVER provided asynchronously may
    // still be resolving while this dispatcher constructs.
    for (const { metatype, meta, moduleIds } of this.discoveredGateways()) {
      const token = gatewayServerToken(metatype);
      if (!getConstructorMetadata(metatype).inject.some((entry) => entry.token === token)) continue;
      this.#container
        .resolve(token)
        .connect(() =>
          this.gatewayServer(metatype, meta, () => this.moduleServer(metatype, moduleIds[0])),
        );
    }
  }

  /**
   * Resolve each gateway's server, awaiting a `WS_SERVER` provided
   * asynchronously that bootstrap has not constructed yet (in a lazy module,
   * say). A provider that fails, or a gateway module that sees an ambiguous
   * `WS_SERVER`, fails bootstrap.
   */
  async onModuleInit(): Promise<void> {
    for (const { metatype, meta, moduleIds } of this.discoveredGateways()) {
      if (this.#gatewayServers.has(metatype)) continue;
      // One provider at a time, in discovery order.
      // oxlint-disable-next-line no-await-in-loop
      const server = await this.resolveModuleServer(metatype, moduleIds[0]);
      this.gatewayServer(metatype, meta, () => server);
    }
  }

  private discoveredGateways(): Array<{
    metatype: Type;
    meta: WebSocketGatewayOptions;
    moduleIds: string[];
  }> {
    return this.#discovery.providersWithMeta<WebSocketGatewayOptions>(WS_GATEWAY_METADATA, {
      metadataOnly: true,
    });
  }

  /**
   * The server a gateway pushes through: the gateway's view of the
   * `WS_SERVER` its declaring module sees (a test double declared next to
   * the gateway, say), else of this module's server. Its pushes reach only
   * the sockets connected through the gateway's path. The gateway's
   * `@WebSocketServer()` is connected to it.
   */
  private gatewayServer(
    gatewayClass: Type,
    options: WebSocketGatewayOptions,
    moduleServer: () => WsServer | undefined,
  ): WsServer | undefined {
    let scoped = this.#gatewayServers.get(gatewayClass);
    if (!scoped) {
      const server = moduleServer() ?? this.#server;
      if (!server) return undefined;
      scoped = gatewayServerOf(server, gatewayClass.name, options);
      this.#gatewayServers.set(gatewayClass, scoped);
    }
    return scoped;
  }

  /**
   * The module whose `WS_SERVER` serves a gateway declared in `moduleId`:
   * that module when it sees exactly one `WS_SERVER`. When it sees none, the
   * server of the dispatcher that connects the gateway serves it. Two or more,
   * whether from several `WebSocketModule` instances or another module beside
   * one, are ambiguous and fail bootstrap: which server pushed would depend on
   * which dispatcher connected the gateway first.
   */
  private serverModule(gatewayClass: Type, moduleId: string | undefined): string | undefined {
    if (moduleId === undefined) return undefined;
    const candidates = this.#container.getVisibleProviderSnapshots(WS_SERVER, moduleId);
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return moduleId;
    const owners = candidates.map((candidate) => candidate.moduleId);
    throw new Error(
      `${gatewayClass.name}'s @WebSocketServer() is ambiguous: its module '${moduleId}' sees ` +
        `${owners.length} WS_SERVER providers, from ${owners.map((owner) => `'${owner}'`).join(', ')}. ` +
        "Provide WS_SERVER in the gateway's module, which answers before its imports, import " +
        'one module that exports it, or override WS_SERVER in the testing module.',
    );
  }

  /** The module's `WS_SERVER` once constructed, as it is before any lifecycle hook runs. */
  private moduleServer(gatewayClass: Type, moduleId: string | undefined): WsServer | undefined {
    const owner = this.serverModule(gatewayClass, moduleId);
    return owner === undefined ? undefined : this.#container.resolve(WS_SERVER, owner);
  }

  private async resolveModuleServer(
    gatewayClass: Type,
    moduleId: string | undefined,
  ): Promise<WsServer | undefined> {
    const owner = this.serverModule(gatewayClass, moduleId);
    return owner === undefined ? undefined : this.#container.resolveAsync(WS_SERVER, owner);
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

      if (entry.server && hasAfterInit(instance)) {
        try {
          await this.initializeGateway(instance, entry.server);
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

  private async initializeGateway(instance: OnGatewayInit, server: WsServer): Promise<void> {
    let pending = this.#initializing.get(instance);
    if (!pending) {
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
    if (entry.server && hasAfterInit(instance))
      await this.initializeGateway(instance, entry.server);
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
        const guards = orderGuardsByPhase(
          await instantiateManyAsync<CanActivate>(globals?.guards ?? [], scope),
        );
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
            ...orderGuardsByPhase(
              await instantiateManyAsync<CanActivate>(globals?.guards ?? [], scope),
            ),
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
        const guards = orderGuardsByPhase(
          await instantiateManyAsync<CanActivate>(globals?.guards ?? [], scope),
        );
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

    const handlers = new Map<string, HandlerEntry>();
    for (const { event, methodName, owner } of gatewaySubscriptions(ctor)) {
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
      // The method's parameter declarations, on the class that declares it.
      const paramMeta = [...(MetadataRegistry.getParameters(owner).get(methodName) ?? [])].sort(
        (a, b) => a.index - b.index,
      );
      const paramTypes = Reflect.getMetadata('design:paramtypes', owner.prototype, methodName) as
        | unknown[]
        | undefined;

      // Recorded before any message, as for HTTP routes (Reflector reads).
      handlerFunction(gatewayClass, methodName);
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
      server: this.gatewayServer(gatewayClass, options, () =>
        this.moduleServer(gatewayClass, moduleId),
      ),
      instance,
      gatewayClass,
      moduleId,
      handlers,
    };
  }
}
