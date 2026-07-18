import type { Type } from '../container/types';
import type { WsArgumentsHost } from '../pipeline/types';
import type { WsClient, WsExecutionContext } from './websocket.types';

const HTTP_ON_WS = (accessor: string) => () => {
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
  container?: unknown,
): WsExecutionContext {
  const host: WsArgumentsHost = {
    getClient: <T = unknown>() => client as T,
    getData: <T = unknown>() => data as T,
    getPattern: <T = string>() => pattern as T,
  };

  return {
    getType: <T extends string = 'ws'>() => 'ws' as T,
    getClass: () => controller,
    getHandler: () => handlerName,
    getModuleId: () => moduleId,
    getContainer: <T = unknown>() => container as T | undefined,
    getContext: HTTP_ON_WS('getContext()') as never,
    getRequest: HTTP_ON_WS('getRequest()') as never,
    switchToHttp: HTTP_ON_WS('switchToHttp()') as never,
    switchToWs: () => host,
  };
}
