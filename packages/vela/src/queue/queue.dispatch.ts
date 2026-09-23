import {
  buildEntrypointExecutionContext,
  getEntrypointModuleId,
  resolveEntrypoint,
  PipelineRunner,
  resolveErrorReporter,
  resolveScopedComponentsAsync,
  runInEntrypointScope,
  shouldFilterCatch,
  parseSchemaAsync,
} from '../index';
import type { Container, ExceptionFilter, Token, Type } from '../index';
import { getProcessHandlers } from './queue.decorators';
import type { ProcessMetadata, ProcessorMetadata, QueueJob } from './queue.types';

export interface QueueDispatchOptions {
  /** Legacy default is ignore. Platform adapters can reject unmatched jobs. */
  unhandled?: 'ignore' | 'error';
}

export interface QueueDispatchResult {
  /**
   * Processors that ran a handler for this job, or 1 when signed dispatch
   * re-entered the job's route.
   */
  handled: number;
}

/** One dispatchable processor: its class token + `@Processor` meta. */
export interface QueueEntry {
  token: Token;
  moduleId?: string;
  meta: ProcessorMetadata;
}

const warnedDuplicates = new WeakSet<object>();

// Processor failures this module already reported, so a transport that settles
// several deliveries reports each failure once.
const reportedFailures = new WeakSet<object>();

/** Whether a processor failure was already reported on the queue edge. */
function isReportedQueueFailure(error: unknown): boolean {
  return (
    ((typeof error === 'object' && error !== null) || typeof error === 'function') &&
    reportedFailures.has(error)
  );
}

/**
 * @internal The failures in a delivery rejection that no processor already
 * reported, looking inside the `AggregateError` several processors (or a
 * batch of deliveries) reject with.
 */
export function unreportedQueueFailures(error: unknown): unknown[] {
  if (isReportedQueueFailure(error)) return [];
  if (error instanceof AggregateError) return error.errors.flatMap(unreportedQueueFailures);
  return [error];
}

/**
 * Mark a reported processor failure so transports do not report it again. A
 * thrown primitive (`throw 'boom'`) cannot be remembered by identity, so it is
 * rethrown wrapped in an `Error` whose `cause` is the thrown value.
 */
function markReported(error: unknown, source: string): unknown {
  const failure =
    (typeof error === 'object' && error !== null) || typeof error === 'function'
      ? error
      : new Error(`Queue processor ${source} threw ${String(error)}`, { cause: error });
  reportedFailures.add(failure);
  return failure;
}

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
 * The DIRECT delivery path: hands one job to every `@Processor` of its queue,
 * without consulting `QueueModule`'s dispatch policy. Only
 * `QueueDispatchBinding`, which applies that policy first, and applications
 * without a `QueueModule` reach it; custom transports call the public
 * `dispatchQueueJob`, which honors the policy.
 *
 * Entries are tokens + meta ONLY (from the per-app `EntrypointRegistry`, or
 * from discovery before the registry exists). Each matching processor runs
 * inside `runInEntrypointScope` (request-scoped dependencies rebuild per job)
 * and is re-resolved BY TOKEN through the async seam, so processors living in
 * `lazy: true` modules materialize cleanly on first dispatch — async providers
 * and lifecycle hooks included. Scoped guards/interceptors/filters run through
 * `PipelineRunner` (`getType() === 'queue'`, `getPayload()` is the job);
 * app-wide `APP_*` components deliberately do NOT apply (cloudflare
 * queue/scheduled parity — documented divergence from the WebSocket
 * dispatcher).
 *
 * Errors no scoped filter claims RETHROW so awaiting platforms keep their
 * retry semantics; fire-and-forget callers (inline `immediate` mode) must
 * catch — `QueueDispatchBinding` routes those to diagnostics.
 *
 * @internal
 */
export async function dispatchJobToProcessors(
  container: Container,
  entries: QueueEntry[],
  job: QueueJob,
  options: QueueDispatchOptions = {},
): Promise<QueueDispatchResult> {
  const processors = entries.filter((entry) => entry.meta.queueName === job.queue);

  if (processors.length === 0) {
    if (options.unhandled === 'error') throw new Error(`No processor for queue '${job.queue}'.`);
    if (container.getDiagnostics() === 'log') {
      console.warn(
        `[vela] queue job '${job.name}' on '${job.queue}' has no @Processor('${job.queue}') — dropped.`,
      );
    }
    return { handled: 0 };
  }

  // Await every processor before acknowledging or rejecting a platform message.
  const outcomes = await Promise.allSettled(
    processors.map((entry) => dispatchToProcessor(container, entry, job)),
  );
  const errors: unknown[] = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : [],
  );
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Queue processors failed.');
  const handled = outcomes.filter(
    (outcome) => outcome.status === 'fulfilled' && outcome.value,
  ).length;
  if (handled === 0 && options.unhandled === 'error') {
    throw new Error(`No handler for job '${job.name}' on queue '${job.queue}'.`);
  }
  return { handled };
}

async function dispatchToProcessor(
  container: Container,
  entry: QueueEntry,
  job: QueueJob,
): Promise<boolean> {
  const processorClass = entry.token;
  if (typeof processorClass !== 'function')
    throw new TypeError('Queue processor token must be a class.');
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
    const moduleId = getEntrypointModuleId(scope, entry);
    const context = buildEntrypointExecutionContext(
      'queue',
      processorClass,
      handler.methodName,
      job,
      moduleId,
      scope,
    );

    let filters: ExceptionFilter[] = [];
    try {
      // Closest-first, matching native queue filter semantics.
      filters = (
        await resolveScopedComponentsAsync(
          'filter',
          processorClass,
          handler.methodName,
          scope,
          moduleId,
        )
      ).toReversed();
      const guards = await resolveScopedComponentsAsync(
        'guard',
        processorClass,
        handler.methodName,
        scope,
        moduleId,
      );
      const interceptors = await resolveScopedComponentsAsync(
        'interceptor',
        processorClass,
        handler.methodName,
        scope,
        moduleId,
      );
      await PipelineRunner.run({
        context,
        guards,
        interceptors,
        resolveArgs: async () => [
          handler.schema
            ? { ...job, data: await parseSchemaAsync(handler.schema, structuredClone(job.data)) }
            : job,
        ],
        invoke: async (args) => {
          const instance = await resolveEntrypoint(scope, { token: processorClass, moduleId });
          if (typeof instance !== 'object' || instance === null)
            throw new TypeError('Queue processor must resolve to an object.');
          const method: unknown = Reflect.get(instance, handler.methodName);
          if (typeof method !== 'function')
            throw new TypeError('Queue processor handler must be a function.');
          return Reflect.apply(method, instance, args);
        },
      });
      return true;
    } catch (error) {
      // Report BEFORE the filter loop and BEFORE any rethrow — every dispatch
      // error reaches the exception handler, whether a scoped filter claims it
      // or it rethrows to preserve platform retry semantics.
      const source = `${processorClass.name}.${String(handler.methodName)}`;
      resolveErrorReporter(scope).report(error, { edge: 'queue', source });
      const reported = markReported(error, source);
      for (const filter of filters) {
        if (shouldFilterCatch(filter, error)) {
          await filter.catch(error, context);
          return true;
        }
      }
      throw reported; // unclaimed → platform retry semantics stay intact
    }
  });
}
