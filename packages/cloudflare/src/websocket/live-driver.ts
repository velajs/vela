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
import { gatewayObjectRoom } from './room-id';
import { gatewayRoomObject, type GatewayRoomObject } from './worker-transport';

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
  /**
   * Room used when an invalidation names none. Matches the client default. A
   * gateway without `roomParam` has one room, its path, which every
   * invalidation reaches.
   */
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

/** Where the Worker delivers invalidations: one gateway's room objects. */
interface LiveTarget {
  env: VelaEnv;
  binding: string;
  gatewayPath: string;
}

function describeFilter({ binding, gatewayPath }: DurableObjectLiveOptions): string {
  const parts = [
    ...(binding === undefined ? [] : [`binding '${binding}'`]),
    ...(gatewayPath === undefined ? [] : [`path '${gatewayPath}'`]),
  ];
  return parts.join(' and ');
}

/** A commit stamp a room object returned, validated before it reaches headers. */
function commitStamp(value: unknown): CommitStamp | undefined {
  if (value === undefined) return undefined;
  const cursor: unknown =
    typeof value === 'object' && value !== null ? Reflect.get(value, 'cursor') : undefined;
  const epoch: unknown =
    typeof value === 'object' && value !== null ? Reflect.get(value, 'epoch') : undefined;
  if (typeof cursor !== 'number' || typeof epoch !== 'string') {
    throw new Error('Durable Object invalidate() returned an invalid commit stamp');
  }
  return { cursor, epoch };
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
  #target: LiveTarget | undefined;

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

  /**
   * @internal The Durable Object that holds one room's subscriptions. As for
   * upgrades and `Gateways` pushes, a gateway without `roomParam` keeps every
   * socket in one room, its path, so each of its rooms is in that object.
   */
  _room(room: string): GatewayRoomObject {
    const { env, binding, gatewayPath } = this.#resolveTarget();
    return gatewayRoomObject(env, gatewayPath, binding, gatewayObjectRoom(gatewayPath, room));
  }

  dispatch(cmd: InvalidationCommand): Promise<CommitStamp | undefined> | CommitStamp | undefined {
    if (this.#local) return this.#sink?.applyInvalidation(cmd);
    const room = cmd.room ?? this.options.defaultRoom ?? DEFAULT_ROOM;
    return this._room(room)
      .call('invalidate', { ...cmd, room })
      .then(commitStamp);
  }

  #resolveTarget(): LiveTarget {
    if (this.#target) return this.#target;
    const context = this.#context;
    if (!context) {
      throw new Error(
        'durableObjectLive() needs the Cloudflare adapter: create the application with ' +
          'createCloudflareWorker(), createCloudflareApp() or cloudflareAdapter().',
      );
    }
    let { binding, gatewayPath } = this.options;
    const gateways = context.gateways();
    if (binding === undefined || gatewayPath === undefined) {
      const candidates = gateways.filter(
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
    const target: LiveTarget = { env: context.env, binding, gatewayPath };
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
 * from `ENV` when first needed, and `LiveInspector` reads each room from that
 * object. A configured local driver is warned about once per isolate:
 * subscriptions live in the Durable Object, so it would reach none.
 */
export function workerLivePlatform(env: VelaEnv, container: Container): LivePlatform {
  const context: WorkerLiveContext = {
    env,
    gateways: () => bindingGateways(container.resolve(DiscoveryService)),
  };
  let bound: CfLiveDriver | undefined;
  return {
    liveDriver: () => durableObjectLive(),
    async inspect(room) {
      if (!bound) throw new Error('LiveModule delivers locally in this Worker: no room to inspect');
      const value: unknown = await bound._room(room).call('inspectLive');
      const subscriptions: unknown =
        typeof value === 'object' && value !== null
          ? Reflect.get(value, 'subscriptions')
          : undefined;
      const rooms: unknown =
        typeof value === 'object' && value !== null ? Reflect.get(value, 'rooms') : undefined;
      if (!Array.isArray(subscriptions) || !Array.isArray(rooms)) {
        throw new Error('Durable Object inspectLive() returned an invalid snapshot');
      }
      return { subscriptions, rooms };
    },
    bindDriver(driver) {
      if (driver instanceof CfLiveDriver) {
        driver._attach(context);
        bound = driver;
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
