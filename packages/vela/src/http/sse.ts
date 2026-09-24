import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor } from '../registry/types';
import { Get, type RouteOptions } from './decorators';

/** One Server-Sent Event, as Nest's `MessageEvent`. */
export interface MessageEvent {
  /** A string is sent as is; anything else as JSON. */
  data: string | object;
  id?: string;
  /** The event name (`event:` field). */
  type?: string;
  /** Reconnection delay in milliseconds. */
  retry?: number;
}

/** What an `@Sse()` handler returns: a stream of events, or a ready Response. */
export type SseResult = AsyncIterable<MessageEvent> | Iterable<MessageEvent> | Response;

function isIterable(value: unknown): value is AsyncIterable<MessageEvent> | Iterable<MessageEvent> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Symbol.asyncIterator in value || Symbol.iterator in value)
  );
}

// Streams the handler's events; a failure mid-stream is reported and ends the
// stream without sending its message.
function respondWithEvents(
  c: Context,
  result: unknown,
  onStreamError: (error: unknown) => void,
): Response {
  if (result instanceof Response) return result;
  if (!isIterable(result)) {
    throw new TypeError('@Sse() handlers must return an iterable of MessageEvent or a Response');
  }
  return streamSSE(c, async (stream) => {
    const iterator =
      Symbol.asyncIterator in result ? result[Symbol.asyncIterator]() : result[Symbol.iterator]();
    stream.onAbort(() => {
      void Promise.resolve(iterator.return?.()).catch(() => {});
    });
    try {
      while (!stream.aborted) {
        const next = await iterator.next();
        if (next.done || stream.aborted) break;
        const { data, id, type, retry } = next.value;
        await stream.writeSSE({
          data: typeof data === 'string' ? data : JSON.stringify(data),
          ...(type === undefined ? {} : { event: type }),
          ...(id === undefined ? {} : { id }),
          ...(retry === undefined ? {} : { retry }),
        });
      }
    } catch (error) {
      if (!stream.aborted) onStreamError(error);
    } finally {
      if (!stream.aborted) await iterator.return?.();
    }
  });
}

/**
 * A GET route that streams Server-Sent Events, as Nest's `@Sse()`. The handler
 * returns an async iterable (such as an async generator) of `MessageEvent`s;
 * each is written as it is produced, and the iterable is closed when the
 * client disconnects. A returned `Response` is sent as is.
 *
 * @example
 * ```ts
 * @Sse('/events')
 * async *events(): AsyncIterable<MessageEvent> {
 *   yield { data: { ready: true }, type: 'status' };
 * }
 * ```
 */
export function Sse(path = '', options?: RouteOptions) {
  return <Handler extends (...args: never[]) => SseResult | Promise<SseResult>>(
    target: object,
    propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<Handler>,
  ): void => {
    Get(path, options)(target, propertyKey, descriptor);
    MetadataRegistry.setHandlerHttpMeta(target.constructor as Constructor, propertyKey, {
      respond: respondWithEvents,
    });
  };
}
