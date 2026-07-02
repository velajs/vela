import type { Type } from '../container/types';
import type { ArgumentMetadata, PipeTransform } from '../pipeline/types';
import type { ParameterMetadata } from '../registry/types';
import { WsParamType } from './websocket.tokens';
import type { WsClient } from './websocket.types';

/**
 * Builds handler arguments for a gateway message. WS sibling of the HTTP
 * `ArgumentResolver`, but sourced from the envelope (`data`) and the socket
 * (`client`) instead of the Hono `Context`.
 *
 * With no parameter decorators the handler receives `(client, data)` — the
 * NestJS gateway convention. Pipes run only over `@MessageBody()` values, where
 * validation/transformation is meaningful.
 */
export async function resolveWsArgs(
  paramMeta: ParameterMetadata[],
  client: WsClient,
  data: unknown,
  pipes: PipeTransform[],
  paramTypes?: unknown[],
): Promise<unknown[]> {
  if (paramMeta.length === 0) {
    return [client, data];
  }

  const maxIndex = paramMeta[paramMeta.length - 1].index;
  const args: unknown[] = new Array(maxIndex + 1).fill(undefined);

  for (const param of paramMeta) {
    if (param.type === WsParamType.SOCKET) {
      args[param.index] = client;
      continue;
    }

    if (param.type === WsParamType.BODY) {
      let value: unknown = data;
      const metadata: ArgumentMetadata = {
        type: param.type,
        data: param.name,
        metatype: paramTypes?.[param.index] as Type | undefined,
      };
      for (const pipe of pipes) {
        value = await pipe.transform(value, metadata);
      }
      args[param.index] = value;
      continue;
    }

    args[param.index] = undefined;
  }

  return args;
}
