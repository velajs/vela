import { resolveErrorReporter, type EntrypointExecutionContext } from '@velajs/vela/module-kit';
import type { CloudflareApplication } from '../cloudflare-application';
import { entrypointInvoker, observedSettlement } from '../host/host-invoker';

/** The metadata key `@OnTail()` records its handlers under (entrypoint kind `cf:tail`). */
export const TAIL_METADATA = 'cloudflare:tail';

/** One `@OnTail()` handler. */
export interface OnTailMetadata {
  readonly methodName: string;
}

/** The ExecutionContext guards, interceptors and filters receive around an `@OnTail()` handler. */
export type TailExecutionContext = EntrypointExecutionContext<'cf:tail'>;

function handlerName(meta: unknown): string {
  const methodName: unknown =
    typeof meta === 'object' && meta !== null ? Reflect.get(meta, 'methodName') : undefined;
  if (typeof methodName !== 'string') throw new Error('Invalid @OnTail() metadata.');
  return methodName;
}

/**
 * Deliver a batch of Tail Workers events to every `@OnTail()` handler of the
 * application, each in its own execution scope through its scoped guards,
 * interceptors and filters. A failure, in a handler or around it, is reported
 * (`edge: 'tail'`) and never reaches the platform: a failing tail handler
 * must not fail the events it observes.
 */
export async function dispatchTail(
  application: CloudflareApplication,
  events: unknown,
): Promise<void> {
  const container = application.getContainer();
  const handlers = application.entrypoints.ofKind('cf:tail');
  await Promise.all(
    handlers.map(async (entry) => {
      let source = 'an @OnTail() handler';
      try {
        const method = handlerName(entry.meta);
        const invoker = entrypointInvoker(container, entry, 'tail');
        source = invoker.report('cf:tail', method).source ?? source;
        if (!Array.isArray(events)) throw new TypeError('The tail handler received no events.');
        await invoker.invoke({
          kind: 'cf:tail',
          method,
          args: [events],
          payload: events,
          settlement: observedSettlement,
        });
      } catch (error) {
        try {
          resolveErrorReporter(container).report(error, { edge: 'tail', source, kind: 'cf:tail' });
        } catch {
          console.error(`[vela] tail error in ${source}:`, error);
        }
      }
    }),
  );
}
