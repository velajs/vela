import {
  buildEntrypointExecutionContext,
  PipelineRunner,
  resolveErrorReporter,
  resolveScopedComponents,
  runInEntrypointScope,
  shouldFilterCatch,
} from '../index';
import type { Container, EntrypointRegistry, Token, Type } from '../index';
import { getProcessHandlers } from './queue.decorators';
import type { ProcessMetadata, ProcessorMetadata, QueueJob } from './queue.types';

export interface QueueDispatchResult {
  /** Processors that ran a handler for this job. */
  handled: number;
}

/** One dispatchable processor: its class token + `@Processor` meta. */
export interface QueueEntry {
  token: Token;
  meta: ProcessorMetadata;
}

const warnedDuplicates = new WeakSet<object>();

function selectHandler(
  container: Container,
  processorClass: Type,
  handlers: ProcessMetadata[],
  jobName: string,
): ProcessMetadata | undefined {
  const named = handlers.filter((h) => h.jobName === jobName);
  const pool = named.length > 0 ? named : handlers.filter((h) => h.jobName === undefined);
  if (pool.length > 1 && !warnedDuplicates.has(processorClass)) {
    warnedDuplicates.add(processorClass);
    const label = named.length > 0 ? `@Process('${jobName}')` : '@Process() (wildcard)';
    const message =
      `[vela] duplicate ${label} handlers on ${processorClass.name}; ` +
      `keeping the first ('${String(pool[0]!.methodName)}').`;
    if (container.getDiagnostics() === 'throw') throw new Error(message);
    if (container.getDiagnostics() === 'log') console.warn(message);
  }
  return pool[0];
}

/**
 * Deliver one job to every `@Processor` of its queue — the primitive both the
 * in-core `inline()` driver and platform adapters call.
 *
 * Each matching processor runs inside `runInEntrypointScope` (request-scoped
 * dependencies rebuild per job) and is re-resolved BY TOKEN through the async
 * seam, so processors living in `lazy: true` modules materialize cleanly on
 * first dispatch — async providers and lifecycle hooks included. Scoped
 * guards/interceptors/filters run through `PipelineRunner`
 * (`getType() === 'queue'`, `getPayload()` is the job); app-wide `APP_*`
 * components deliberately do NOT apply (cloudflare queue/scheduled parity —
 * documented divergence from the WebSocket dispatcher).
 *
 * Errors no scoped filter claims RETHROW so awaiting platforms keep their
 * retry semantics; fire-and-forget callers (inline `immediate` mode) must
 * catch — `QueueDispatchBinding` routes those to diagnostics.
 */
export async function dispatchQueueJob(
  container: Container,
  entrypoints: EntrypointRegistry,
  job: QueueJob,
): Promise<QueueDispatchResult> {
  const entries = entrypoints
    .ofKind<ProcessorMetadata>('queue')
    .map((ep) => ({ token: ep.token, meta: ep.meta }));
  return dispatchJobToEntries(container, entries, job);
}

/**
 * Entry-list core shared by `dispatchQueueJob` (registry) and the in-process
 * driver binding (discovery fallback before the registry exists). Entries are
 * tokens + meta ONLY — every processor is re-resolved by token in its own
 * scope, so request-scoped and lazy-module processors work on both paths.
 */
export async function dispatchJobToEntries(
  container: Container,
  entries: QueueEntry[],
  job: QueueJob,
): Promise<QueueDispatchResult> {
  const processors = entries.filter((entry) => entry.meta.queueName === job.queue);

  if (processors.length === 0) {
    if (container.getDiagnostics() === 'log') {
      console.warn(
        `[vela] queue job '${job.name}' on '${job.queue}' has no @Processor('${job.queue}') — dropped.`,
      );
    }
    return { handled: 0 };
  }

  // All matching processors receive the job; the first unclaimed error
  // rejects the whole dispatch (platform retries the delivery — CF parity).
  const outcomes = await Promise.all(
    processors.map((entry) => dispatchToProcessor(container, entry.token as Type, job)),
  );
  return { handled: outcomes.filter(Boolean).length };
}

async function dispatchToProcessor(
  container: Container,
  processorClass: Type,
  job: QueueJob,
): Promise<boolean> {
  const handler = selectHandler(
    container,
    processorClass,
    getProcessHandlers(processorClass),
    job.name,
  );
  if (!handler) {
    if (container.getDiagnostics() === 'log') {
      console.warn(
        `[vela] no @Process('${job.name}') (or wildcard) handler on ` +
          `${processorClass.name} for queue '${job.queue}' — skipped.`,
      );
    }
    return false;
  }

  return runInEntrypointScope(container, async (scope) => {
    // Async seam: materializes lazy processor modules (drainAsync awaits
    // their async providers/hooks) and rebuilds request-scoped processors.
    const instance = (await scope.resolveAsync(processorClass)) as Record<string | symbol, unknown>;
    const context = buildEntrypointExecutionContext(
      'queue',
      processorClass,
      handler.methodName,
      job,
    );

    const guards = resolveScopedComponents('guard', processorClass, handler.methodName, scope);
    const interceptors = resolveScopedComponents(
      'interceptor',
      processorClass,
      handler.methodName,
      scope,
    );
    // Closest-first: handler/class filters reversed by the caller (WS/CF convention).
    const filters = resolveScopedComponents(
      'filter',
      processorClass,
      handler.methodName,
      scope,
    ).reverse();

    try {
      await PipelineRunner.run({
        context,
        guards,
        interceptors,
        resolveArgs: async () => [job],
        invoke: async (args) => {
          const method = instance[handler.methodName] as (...a: unknown[]) => unknown;
          return method.apply(instance, args);
        },
      });
      return true;
    } catch (error) {
      // Report BEFORE the filter loop and BEFORE any rethrow — every dispatch
      // error reaches the exception handler, whether a scoped filter claims it
      // or it rethrows to preserve platform retry semantics.
      resolveErrorReporter(scope).report(error, {
        edge: 'queue',
        source: `${processorClass.name}.${String(handler.methodName)}`,
      });
      for (const filter of filters) {
        if (shouldFilterCatch(filter, error)) {
          await filter.catch(error, context);
          return true;
        }
      }
      throw error; // unclaimed → platform retry semantics stay intact
    }
  });
}
