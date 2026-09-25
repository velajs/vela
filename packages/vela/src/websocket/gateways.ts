import { Inject, Injectable } from '../container/decorators';
import type { Type } from '../container/types';
import { MetadataRegistry } from '../registry/metadata.registry';
import {
  assertWebSocketRoomId,
  resolveGatewayRoomParam,
  resolveMaxFrameBytes,
} from './gateway-routing';
import { WebSocketPlatform } from './upgrade-routes';
import { WS_GATEWAY_METADATA, WS_SYNC_DRIVER } from './websocket.tokens';
import type {
  BroadcastCommand,
  GatewayBroadcastOperator,
  GatewayDelivery,
  GatewayEventArgs,
  GatewayServer,
  WebSocketGatewayOptions,
} from './websocket.types';
import { forwardedGatewayPushError, forwardedSocketsUnreachable } from './ws-server';
import { assertBroadcastCommandFits, type SyncDriver } from './ws-sync';

/** What a push needs from one gateway's `@WebSocketGateway` metadata. */
interface GatewayTarget {
  name: string;
  path: string;
  binding?: string;
  roomParam?: string;
  maxFrameBytes: number;
}

type Push = (rooms: readonly string[], event: string, data: unknown) => Promise<void>;

/** Failed rooms a multi-room push's rejection message names; `errors` holds all. */
const MAX_NAMED_FAILED_ROOMS = 10;

function isGatewayOptions(value: unknown): value is WebSocketGatewayOptions {
  if (typeof value !== 'object' || value === null) return false;
  const path: unknown = Reflect.get(value, 'path');
  const binding: unknown = Reflect.get(value, 'binding');
  return (
    (path === undefined || typeof path === 'string') &&
    (binding === undefined || typeof binding === 'string')
  );
}

function readGateway(gateway: Type): GatewayTarget {
  const options: unknown = MetadataRegistry.getCustomClassMeta(gateway, WS_GATEWAY_METADATA);
  if (!isGatewayOptions(options)) {
    throw new TypeError(
      `${gateway.name} is not a @WebSocketGateway: Gateways.of() takes a gateway class.`,
    );
  }
  const roomParam = resolveGatewayRoomParam(options);
  return {
    name: gateway.name,
    path: options.path ?? '',
    ...(options.binding === undefined ? {} : { binding: options.binding }),
    ...(roomParam === undefined ? {} : { roomParam }),
    maxFrameBytes: resolveMaxFrameBytes(options),
  };
}

function exceptUnsupported(): never {
  throw new Error(
    'A Gateways push reaches every socket in every room it names; except() is not supported. ' +
      "Filter recipients with the gateway's authorizeDelivery option.",
  );
}

class GatewayBroadcastOperatorImpl<
  Events extends object,
> implements GatewayBroadcastOperator<Events> {
  readonly #rooms: ReadonlySet<string>;

  constructor(
    private readonly push: Push,
    rooms: ReadonlySet<string>,
  ) {
    this.#rooms = rooms;
  }

  to(room: string): GatewayBroadcastOperator<Events> {
    assertWebSocketRoomId(room);
    return new GatewayBroadcastOperatorImpl<Events>(this.push, new Set([...this.#rooms, room]));
  }

  in(room: string): GatewayBroadcastOperator<Events> {
    return this.to(room);
  }

  except(): never {
    return exceptUnsupported();
  }

  emit<Event extends keyof Events & string>(
    event: Event,
    ...data: GatewayEventArgs<Events, Event>
  ): Promise<void> {
    return this.push([...this.#rooms], event, data[0]);
  }
}

class GatewayServerImpl<Events extends object> implements GatewayServer<Events> {
  constructor(
    private readonly target: GatewayTarget,
    private readonly push: Push,
  ) {}

  get path(): string {
    return this.target.path;
  }

  to(room: string): GatewayBroadcastOperator<Events> {
    return new GatewayBroadcastOperatorImpl<Events>(this.push, new Set()).to(room);
  }

  in(room: string): GatewayBroadcastOperator<Events> {
    return this.to(room);
  }

  emit(): never {
    const name = this.target.name;
    throw new Error(
      `gateways.of(${name}).emit() names no room: ${name}'s sockets live with their room, so ` +
        `a push without one would reach no one. Push with gateways.of(${name}).to(room).emit(event, data).`,
    );
  }

  except(): never {
    return exceptUnsupported();
  }
}

/**
 * Pushes server-initiated events to a gateway's rooms from anywhere in the
 * application: an HTTP handler, a queue consumer, a cron job or another
 * gateway.
 *
 * ```ts
 * interface ChatEvents { message: { from: string; text: string } }
 *
 * constructor(private readonly gateways: Gateways) {}
 *
 * await this.gateways.of<ChatEvents>(ChatGateway).to(roomId).emit('message', { from, text });
 * ```
 *
 * The explicit event map types each push. The target comes from the
 * gateway's `@WebSocketGateway` metadata (`path`, `binding`, `roomParam`),
 * each push is bounded by its `maxFrameBytes`, and it reaches only that
 * gateway's sockets, even where another gateway has a room with the same id.
 * A platform transport that delivers pushes receives one `GatewayDelivery`
 * per room (on Cloudflare, a broadcast RPC to that gateway room's Durable
 * Object), and a push to several rooms rejects with an `AggregateError` that
 * holds one error per room it failed to reach; otherwise the push goes
 * through the module's sync driver to this process's sockets (and, with
 * `redis()`, to every instance's). A push to a gateway whose upgrades a
 * transport forwards elsewhere, when neither that transport nor the
 * `local()` sync driver can reach its sockets, rejects.
 */
@Injectable()
export class Gateways {
  constructor(
    @Inject(WebSocketPlatform) private readonly platform: WebSocketPlatform,
    @Inject(WS_SYNC_DRIVER) private readonly driver: SyncDriver,
  ) {}

  /** The typed push handle of one `@WebSocketGateway` class. */
  of<Events extends object = Record<string, unknown>>(gateway: Type): GatewayServer<Events> {
    const target = readGateway(gateway);
    return new GatewayServerImpl<Events>(target, (rooms, event, data) =>
      this.push(target, rooms, event, data),
    );
  }

  private async push(
    target: GatewayTarget,
    rooms: readonly string[],
    event: string,
    data: unknown,
  ): Promise<void> {
    if (rooms.length === 0) return;
    const command: BroadcastCommand = {
      rooms: [...rooms],
      gatewayPath: target.path,
      frame: JSON.stringify({ event, data }),
    };
    assertBroadcastCommandFits(command, target.maxFrameBytes);
    const transport = this.platform.transport;
    if (!transport?.deliver) {
      // The upgrade route hands a gateway's sockets to another isolate, which
      // only a cross-instance sync driver can reach.
      if (target.binding !== undefined && forwardedSocketsUnreachable(transport, this.driver)) {
        throw forwardedGatewayPushError(target.name);
      }
      await this.driver.dispatch(command);
      return;
    }
    const deliver = transport.deliver.bind(transport);
    // A gateway without roomParam admits every upgrade into one room, its path.
    const gatewayRooms = target.roomParam === undefined ? [target.path] : command.rooms;
    const deliveries = gatewayRooms.map((room) => {
      const delivery: GatewayDelivery = { gatewayPath: target.path, room, command };
      if (target.binding !== undefined) delivery.binding = target.binding;
      return delivery;
    });
    const outcomes = await Promise.all(
      deliveries.map(async (delivery): Promise<{ room: string; reason: unknown } | undefined> => {
        try {
          await deliver(delivery);
          return undefined;
        } catch (reason) {
          return { room: delivery.room, reason };
        }
      }),
    );
    const failed = outcomes.filter((outcome) => outcome !== undefined);
    const [first] = failed;
    if (first === undefined) return;
    if (deliveries.length === 1) throw first.reason;
    // Name each room that missed the push; the others received it.
    const missed = failed.map(({ room, reason }) => {
      const name = JSON.stringify(room);
      return {
        name,
        error: new Error(`${target.name} push to room ${name} failed`, { cause: reason }),
      };
    });
    // Room ids reach 512 bytes: the message names the first few, and `errors`
    // keeps one entry per failed room.
    const named = missed.slice(0, MAX_NAMED_FAILED_ROOMS).map(({ name }) => name);
    const more = missed.length - named.length;
    throw new AggregateError(
      missed.map(({ error }) => error),
      `${failed.length} of ${deliveries.length} ${target.name} room pushes failed: ` +
        named.join(', ') +
        (more > 0 ? ` and ${more} more` : ''),
    );
  }
}
