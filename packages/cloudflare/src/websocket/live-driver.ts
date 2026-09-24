import type { VelaEnv } from '@velajs/vela';
import { DiscoveryService, type Container } from '@velajs/vela/module-kit';
import type {
  CommitStamp,
  InvalidationCommand,
  LiveDriver,
  LiveInvalidationSink,
  LivePlatform,
} from '@velajs/vela/live';
import { bindingGateways, type BindingGateway } from './binding-gateways';
import { roomToDurableId } from './room-id';

const DEFAULT_ROOM = 'default';

export interface DurableObjectLiveOptions {
  /**
   * Durable Object namespace binding that holds the gateway's rooms, read from
   * the application's `ENV` when an invalidation first needs it. Defaults to
   * the `binding` of the chosen gateway.
   */
  binding?: string;
  /**
   * Exact `@WebSocketGateway()` path whose rooms hold the subscriptions.
   * Defaults to the single gateway backed by `binding` (or by any binding).
   */
  gatewayPath?: string;
  /** Room used when an invalidation names none. Matches the client default. */
  defaultRoom?: string;
}

export interface LiveInvalidateStub {
  invalidate(cmd: InvalidationCommand): Promise<CommitStamp | undefined>;
}

/** Only the native namespace operations required for live invalidation. */
export interface LiveNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): LiveInvalidateStub;
}

/** @internal What the Worker's live platform hands a driver. */
interface WorkerLiveContext {
  env: VelaEnv;
  gateways(): readonly Pick<BindingGateway, 'path' | 'binding'>[];
}

function describeFilter({ binding, gatewayPath }: DurableObjectLiveOptions): string {
  const parts = [
    ...(binding === undefined ? [] : [`binding '${binding}'`]),
    ...(gatewayPath === undefined ? [] : [`path '${gatewayPath}'`]),
  ];
  return parts.join(' and ');
}

/** Read a namespace binding by name, validating the operations the driver calls. */
function readNamespace(env: VelaEnv, binding: string): LiveNamespace {
  const value: unknown = Reflect.get(env, binding);
  const idFromName: unknown =
    typeof value === 'object' && value !== null ? Reflect.get(value, 'idFromName') : undefined;
  const get: unknown =
    typeof value === 'object' && value !== null ? Reflect.get(value, 'get') : undefined;
  if (typeof idFromName !== 'function' || typeof get !== 'function') {
    throw new Error(
      `Live invalidations target the Durable Object binding '${binding}', which this ` +
        'environment does not provide. Declare it in the Wrangler configuration.',
    );
  }
  return {
    idFromName: (name) => Reflect.apply(idFromName, value, [name]),
    get(id) {
      const stub: unknown = Reflect.apply(get, value, [id]);
      const invalidate: unknown =
        typeof stub === 'object' && stub !== null ? Reflect.get(stub, 'invalidate') : undefined;
      if (typeof invalidate !== 'function') {
        throw new Error(`Durable Object binding '${binding}' has no invalidate() RPC method.`);
      }
      return { invalidate: (cmd) => Reflect.apply(invalidate, stub, [cmd]) };
    },
  };
}

/**
 * Delivers live invalidations to the room Durable Object of a
 * `@WebSocketGateway({ binding })`, whose SQLite log stamps the commit. Inside
 * that Durable Object the same driver applies invalidations locally.
 */
export class CfLiveDriver implements LiveDriver {
  readonly kind = 'durable-object';
  #sink: LiveInvalidationSink | undefined;
  #local = false;
  #context: WorkerLiveContext | undefined;
  #target: { namespace: LiveNamespace; gatewayPath: string } | undefined;

  constructor(private readonly options: DurableObjectLiveOptions = {}) {}

  bind(sink: LiveInvalidationSink): void {
    this.#sink = sink;
  }

  /** @internal The Worker's live platform supplies its environment and gateways. */
  _attach(context: WorkerLiveContext): void {
    this.#context = context;
    this.#target = undefined;
  }

  /** @internal A Durable Object dispatches to its own engine and SQLite log. */
  _setLocalMode(): void {
    this.#local = true;
  }

  dispatch(cmd: InvalidationCommand): Promise<CommitStamp | undefined> | CommitStamp | undefined {
    if (this.#local) return this.#sink?.applyInvalidation(cmd);
    const { namespace, gatewayPath } = this.#resolveTarget();
    const room = cmd.room ?? this.options.defaultRoom ?? DEFAULT_ROOM;
    return namespace
      .get(roomToDurableId(namespace, gatewayPath, room))
      .invalidate({ ...cmd, room });
  }

  #resolveTarget(): { namespace: LiveNamespace; gatewayPath: string } {
    if (this.#target) return this.#target;
    const context = this.#context;
    if (!context) {
      throw new Error(
        'durableObjectLive() needs the Cloudflare adapter: create the application with ' +
          'createCloudflareWorker(), createCloudflareApp() or cloudflareAdapter().',
      );
    }
    let { binding, gatewayPath } = this.options;
    if (binding === undefined || gatewayPath === undefined) {
      const candidates = context
        .gateways()
        .filter(
          (gateway) =>
            (binding === undefined || gateway.binding === binding) &&
            (gatewayPath === undefined || gateway.path === gatewayPath),
        );
      const [chosen, ...others] = candidates;
      if (!chosen) {
        const filter = describeFilter(this.options);
        throw new Error(
          filter
            ? `durableObjectLive() found no @WebSocketGateway with ${filter}. Name the gateway ` +
                'that holds the subscriptions, with its binding.'
            : 'LiveModule delivers Worker invalidations to the room Durable Object of a ' +
                'gateway, but no @WebSocketGateway names a binding. Declare one with ' +
                '{ binding }, or pass driver: () => durableObjectLive({ binding, gatewayPath }).',
        );
      }
      if (others.length > 0) {
        const paths = candidates.map((gateway) => `'${gateway.path}'`).join(', ');
        throw new Error(
          `LiveModule must choose where Worker invalidations go, but several binding-backed ` +
            `gateways (${paths}) could hold the subscriptions. Pass ` +
            'driver: () => durableObjectLive({ gatewayPath }) to LiveModule.',
        );
      }
      binding ??= chosen.binding;
      gatewayPath ??= chosen.path;
    }
    const target = { namespace: readNamespace(context.env, binding), gatewayPath };
    this.#target = target;
    return target;
  }
}

/**
 * The Cloudflare live driver, for `LiveModule.forRoot({ driver })`. It is the
 * default on Cloudflare, so name it only to choose a gateway, binding or
 * default room:
 *
 * ```ts
 * LiveModule.forRoot({ driver: () => durableObjectLive({ gatewayPath: '/rooms/:id/ws' }) })
 * ```
 */
export function durableObjectLive(options: DurableObjectLiveOptions = {}): CfLiveDriver {
  return new CfLiveDriver(options);
}

let workerLocalLiveWarned = false;

/**
 * The Worker isolate's live platform: invalidations default to the room
 * Durable Object of the application's binding-backed gateway, chosen and read
 * from `ENV` when first needed. A configured local driver is warned about once
 * per isolate: subscriptions live in the Durable Object, so it would reach none.
 */
export function workerLivePlatform(env: VelaEnv, container: Container): LivePlatform {
  const context: WorkerLiveContext = {
    env,
    gateways: () => bindingGateways(container.resolve(DiscoveryService)),
  };
  return {
    liveDriver: () => durableObjectLive(),
    bindDriver(driver) {
      if (driver instanceof CfLiveDriver) {
        driver._attach(context);
        return;
      }
      if (driver.kind !== 'local' || workerLocalLiveWarned) return;
      if (container.getDiagnostics() === 'silent') return;
      workerLocalLiveWarned = true;
      console.warn(
        '[vela] LiveModule is running localLive() in the Worker isolate: its subscriptions live ' +
          'in the WebSocket Durable Object, so invalidations sent from the Worker never reach ' +
          'them. Remove the driver option to deliver through the gateway room Durable Object.',
      );
    },
  };
}
