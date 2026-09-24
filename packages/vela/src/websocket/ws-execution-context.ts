import type { Container } from '../container/container';
import type { Type } from '../container/types';
import { handlerFunction } from '../pipeline/handler-function';
import type { WsArgumentsHost } from '../pipeline/types';
import type { WsClient, WsExecutionContext } from './websocket.types';

const HTTP_ON_WS =
  (accessor: string): (() => never) =>
  () => {
    throw new Error(
      `${accessor} called on a WebSocket ExecutionContext. This handler runs over a gateway message, not HTTP — use switchToWs().`,
    );
  };

/**
 * WebSocket sibling of `buildExecutionContext` (`http/execution-context.ts`).
 * Guards/pipes/interceptors/filters that read `getClass()`/`getHandler()` or
 * call `switchToWs()` reuse unchanged; the HTTP-only accessors throw rather
 * than fabricate a fake `Request`.
 */
export function buildWsExecutionContext(
  client: WsClient,
  data: unknown,
  controller: Type,
  handlerName: string | symbol,
  pattern: string,
  moduleId?: string,
  container?: Container,
): WsExecutionContext {
  const host: WsArgumentsHost = {
    getClient: () => client,
    getData: () => data,
    getPattern: () => pattern,
  };

  return {
    getType: () => 'ws',
    getClass: () => controller,
    getHandler: () => handlerFunction(controller, handlerName),
    getHandlerName: () => handlerName,
    getModuleId: () => moduleId,
    getContainer: () => container,
    getContext: HTTP_ON_WS('getContext()'),
    getRequest: HTTP_ON_WS('getRequest()'),
    switchToHttp: HTTP_ON_WS('switchToHttp()'),
    switchToWs: () => host,
  };
}
