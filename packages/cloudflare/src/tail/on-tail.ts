import { MetadataRegistry, registerEntrypointKind } from '@velajs/vela/module-kit';
import { registerWorkerEvent } from '../worker-events';
import { TAIL_METADATA, dispatchTail, type OnTailMetadata } from './tail-dispatch';

// The entrypoint kind, declared next to its decorator; importing the decorator
// also gives every Worker of the isolate its `tail` handler.
registerEntrypointKind({ kind: 'cf:tail', metaKey: TAIL_METADATA, level: 'method' });
registerWorkerEvent('tail', (application, events) => dispatchTail(application, events));

/** A method decorator whose method receives a batch of Tail Workers events. */
export type OnTailDecorator = <Handler extends (events: TraceItem[]) => unknown>(
  target: object,
  key: string | symbol,
  descriptor: TypedPropertyDescriptor<Handler>,
) => void;

/**
 * Handle Tail Workers events (entrypoint kind `cf:tail`): the method of an
 * `@Injectable()` provider receives each batch of `TraceItem`s that the
 * Workers naming this one in `tail_consumers` produce:
 *
 * ```ts
 * @Injectable()
 * export class ErrorTail {
 *   constructor(private readonly alerts: AlertsService) {}
 *
 *   @OnTail()
 *   async observe(events: TraceItem[]): Promise<void> {
 *     const failed = events.filter((event) => event.outcome !== 'ok');
 *     if (failed.length > 0) await this.alerts.notify(failed);
 *   }
 * }
 * ```
 *
 * Importing it gives the Worker (`app.worker`) its `tail` handler. Every
 * `@OnTail()` handler receives every batch, each in its own execution scope
 * through its scoped guards, interceptors and filters. A failure is reported
 * (`edge: 'tail'`) and never thrown into the platform's tail loop.
 */
export function OnTail(): OnTailDecorator {
  return (target, key) => {
    if (typeof key !== 'string') throw new TypeError('@OnTail() decorates a string-named method.');
    MetadataRegistry.appendCustomClassMeta<OnTailMetadata>(target.constructor, TAIL_METADATA, {
      methodName: key,
    });
  };
}
