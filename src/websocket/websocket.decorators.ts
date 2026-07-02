import { Scope } from '../constants';
import { Inject } from '../container/decorators';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor } from '../registry/types';
import { WS_GATEWAY_METADATA, WS_SERVER, WS_SUBSCRIBE_METADATA, WsParamType } from './websocket.tokens';
import type { SubscribeMessageMetadata, WebSocketGatewayOptions } from './websocket.types';

/**
 * Marks a class as a WebSocket gateway. Mirrors `@Controller` for the socket
 * transport: registers the class as an injectable singleton and stores its
 * routing options (`path`, Cloudflare `binding`).
 *
 * @example
 * ```ts
 * @WebSocketGateway({ path: '/rooms/:id/ws', binding: 'CHAT_ROOM' })
 * class ChatGateway {}
 * ```
 */
export function WebSocketGateway(options: WebSocketGatewayOptions = {}): ClassDecorator {
  return (target) => {
    const ctor = target as unknown as Constructor;
    MetadataRegistry.setCustomClassMeta(ctor, WS_GATEWAY_METADATA, options);
    MetadataRegistry.markInjectable(ctor);
    MetadataRegistry.setScope(ctor, Scope.SINGLETON);
  };
}

/**
 * Binds a gateway method to an inbound event. Stackable — one class-level list,
 * exactly like `@OnEvent` (`event-emitter.decorators.ts`).
 */
export function SubscribeMessage(event: string): MethodDecorator {
  return (target: object, propertyKey: string | symbol) => {
    MetadataRegistry.appendCustomClassMeta<SubscribeMessageMetadata>(
      target.constructor as Constructor,
      WS_SUBSCRIBE_METADATA,
      { event, methodName: String(propertyKey) },
    );
  };
}

function wsParamDecorator(type: WsParamType): () => ParameterDecorator {
  return () =>
    (target: object, propertyKey: string | symbol | undefined, parameterIndex: number) => {
      if (propertyKey === undefined) {
        throw new Error('WebSocket parameter decorators can only be used on method parameters');
      }
      MetadataRegistry.addParameter(target.constructor as Constructor, propertyKey, {
        index: parameterIndex,
        type,
      });
    };
}

/** Injects the inbound message payload (the envelope's `data`) into a handler parameter. */
export const MessageBody = wsParamDecorator(WsParamType.BODY);

/** Injects the connected socket (`WsClient`) into a handler parameter. */
export const ConnectedSocket = wsParamDecorator(WsParamType.SOCKET);

/**
 * Injects the gateway server handle (`WsServer`). Constructor injection only —
 * the container has no property-injection pass, so this is sugar for
 * `@Inject(WS_SERVER)` on a constructor parameter.
 *
 * @example
 * ```ts
 * constructor(@WebSocketServer() private server: WsServer) {}
 * ```
 */
export function WebSocketServer(): ParameterDecorator {
  return Inject(WS_SERVER);
}
