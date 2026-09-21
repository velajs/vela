import {
  buildEntrypointExecutionContext,
  type Container,
  type EntrypointRegistry,
  PipelineRunner,
  resolveErrorReporter,
  MetadataRegistry,
  runInEntrypointScope,
  shouldFilterCatch,
  type Type,
} from '@velajs/vela';
import { MailError } from '../mail.error';
import { MAIL_INBOUND_GATE } from '../mail.tokens';
import { DEFAULT_INBOUND_GATE, evaluateInboundGate } from './gate';
import type { OnInboundEmailMeta } from './decorator';
import type { InboundEmail } from './parse';

export interface InboundDispatchResult {
  /** True when the app gate rejected the message (no handler ran). */
  gated: boolean;
  /** Handlers that ran. */
  handled: number;
  /** Mechanisms (and `'policy'`) that failed the gate; empty when not gated. */
  failed: string[];
}

async function resolveComponents<T>(
  items: Array<T | Type<T>>,
  scope: Container,
  moduleId: string,
): Promise<T[]> {
  return Promise.all(
    items.map((item) =>
      typeof item === 'function' ? scope.resolveAsync(item as Type<T>, moduleId) : item,
    ),
  );
}

async function runHandler(
  container: Container,
  token: Type,
  moduleId: string,
  methodName: string | symbol,
  email: InboundEmail,
): Promise<void> {
  return runInEntrypointScope(container, async (scope) => {
    // Re-resolve BY TOKEN through the async seam so handlers in lazy modules
    // materialize on first dispatch (async providers/hooks included).
    const instance = await scope.resolveAsync(token, moduleId);
    const context = buildEntrypointExecutionContext(
      'mail:inbound',
      token,
      methodName,
      email,
      moduleId,
      scope,
    );

    try {
      const guards = await resolveComponents(
        [
          ...MetadataRegistry.getController('guard', token),
          ...MetadataRegistry.getHandler('guard', token, methodName),
        ],
        scope,
        moduleId,
      );
      const interceptors = await resolveComponents(
        [
          ...MetadataRegistry.getController('interceptor', token),
          ...MetadataRegistry.getHandler('interceptor', token, methodName),
        ],
        scope,
        moduleId,
      );
      await PipelineRunner.run({
        context,
        guards,
        interceptors,
        resolveArgs: async () => [email],
        invoke: async (args) => {
          if (typeof instance !== 'object' || instance === null) {
            throw new MailError(
              'inbound_rejected',
              '@velajs/mail: inbound handler is not an object',
            );
          }
          const method: unknown = Reflect.get(instance, methodName);
          if (typeof method !== 'function') {
            throw new MailError(
              'inbound_rejected',
              '@velajs/mail: inbound handler method is not callable',
            );
          }
          return Reflect.apply(method, instance, args);
        },
      });
    } catch (error) {
      // Report BEFORE the filter loop and BEFORE any rethrow. Inbound email is
      // an async host-delivered entrypoint (the CF `email()` hook is a sibling
      // of `queue()`/`scheduled()`), so it reports under the 'queue' edge
      // category; vela's `ErrorReportContext.edge` is a closed union without a
      // mail member, and the precise transport rides the open `kind` key.
      resolveErrorReporter(scope).report(error, {
        edge: 'queue',
        kind: 'mail:inbound',
        source: `${token.name}.${String(methodName)}`,
      });
      const filters = await resolveComponents(
        [
          ...MetadataRegistry.getController('filter', token),
          ...MetadataRegistry.getHandler('filter', token, methodName),
        ],
        scope,
        moduleId,
      );
      for (const filter of filters.toReversed()) {
        if (shouldFilterCatch(filter, error)) {
          await filter.catch(error, context);
          return;
        }
      }
      throw error; // unclaimed → host retry semantics
    }
  });
}

/**
 * Dispatch a parsed inbound email through the vela pipeline — the neutral seam
 * a trusted host adapter calls. The app gate is evaluated ONCE, up
 * front: if it fails, NO handler runs (privileged handlers never see an ungated
 * message — the whole security point) and the result reports `gated: true`.
 * Otherwise every `@OnInboundEmail` handler whose optional `match` returns
 * `true` runs once per owning module through `PipelineRunner` inside `runInEntrypointScope`,
 * mirroring `dispatchQueueJob`.
 */
export async function dispatchInboundEmail(
  container: Container,
  entrypoints: EntrypointRegistry,
  email: InboundEmail,
): Promise<InboundDispatchResult> {
  const registeredGates = container.resolveAll(MAIL_INBOUND_GATE);
  if (registeredGates.length > 1) {
    throw new MailError(
      'inbound_rejected',
      '@velajs/mail: multiple inbound authentication gates are registered; select exactly one',
    );
  }
  const gate = registeredGates[0] ?? DEFAULT_INBOUND_GATE;
  const verdict = evaluateInboundGate(gate, email.authentication, email);
  if (!verdict.ok) return { gated: true, handled: 0, failed: verdict.failed };

  const handlers = entrypoints
    .ofKind('mail:inbound', readInboundMetadata)
    .filter((ep) => ep.meta.match?.(email) !== false);

  const invocations = handlers.flatMap((ep) => {
    if (typeof ep.token !== 'function') {
      throw new MailError(
        'inbound_rejected',
        '@velajs/mail: inbound handler must be a class provider',
      );
    }
    const token = ep.token;
    const owners = container.getOwnerModuleIds(token);
    if (owners.length === 0) {
      throw new MailError(
        'inbound_rejected',
        '@velajs/mail: inbound handler does not belong to this application',
      );
    }
    return owners.map((moduleId) => ({ token, moduleId, methodName: ep.meta.methodName }));
  });
  // Wait for every invocation to finish and dispose before rejecting to the
  // host. An early Promise.all rejection could race retry with ongoing work.
  const results = await Promise.allSettled(
    invocations.map(({ token, moduleId, methodName }) =>
      runHandler(container, token, moduleId, methodName, email),
    ),
  );
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;

  return { gated: false, handled: invocations.length, failed: [] };
}

function readInboundMetadata(value: unknown): OnInboundEmailMeta {
  if (typeof value !== 'object' || value === null) {
    throw new MailError('inbound_rejected', '@velajs/mail: malformed inbound metadata');
  }
  const methodName: unknown = Reflect.get(value, 'methodName');
  const match: unknown = Reflect.get(value, 'match');
  if (
    (typeof methodName !== 'string' && typeof methodName !== 'symbol') ||
    (match !== undefined && typeof match !== 'function')
  ) {
    throw new MailError('inbound_rejected', '@velajs/mail: malformed inbound metadata');
  }
  return match === undefined
    ? { methodName }
    : {
        methodName,
        match: (email) => Reflect.apply(match, undefined, [email]) === true,
      };
}
