import type { Container } from '../container/container';
import type { InferToken, Token, Type } from '../container/types';
import { handlerFunction } from '../pipeline/handler-function';
import type { ExecutionContext } from '../pipeline/types';
import { assertExecutionScopeActive } from './execution-scope';

/** ExecutionContext flavor handed to components around entrypoint dispatch. */
export interface EntrypointExecutionContext<Kind extends string = string> extends ExecutionContext {
  getType(): Kind;
  getContext(): never;
  getRequest(): never;
  switchToHttp(): never;
  switchToWs(): never;
  /** The dispatch payload (queue batch, scheduled event, …). */
  getPayload(): unknown;
}

const WRONG_TRANSPORT =
  (accessor: string, kind: string): (() => never) =>
  () => {
    throw new Error(
      `${accessor} called on a '${kind}' entrypoint ExecutionContext — this ` +
        `handler runs over an entrypoint dispatch, not that transport. Use ` +
        `getType()/getPayload() to branch.`,
    );
  };

/**
 * Entrypoint sibling of `buildExecutionContext` (HTTP) and
 * `buildWsExecutionContext`: lets guards/interceptors/filters written against
 * `getClass()`/`getHandler()`/`getType()` run unchanged around queue batches,
 * scheduled ticks, and any custom entrypoint kind. Transport-specific
 * accessors throw rather than fabricate fakes.
 */
export function buildEntrypointExecutionContext<const Kind extends string>(
  kind: Kind,
  targetClass: Type,
  handlerName: string | symbol,
  payload: unknown,
  moduleId?: string,
  container?: Container,
): EntrypointExecutionContext<Kind> {
  return {
    getType: () => kind,
    getClass: () => targetClass,
    getHandler: () => handlerFunction(targetClass, handlerName),
    getHandlerName: () => handlerName,
    getModuleId: () => moduleId,
    getContainer: () => container,
    getPayload: () => payload,
    getContext: WRONG_TRANSPORT('getContext()', kind),
    getRequest: WRONG_TRANSPORT('getRequest()', kind),
    switchToHttp: WRONG_TRANSPORT('switchToHttp()', kind),
    switchToWs: WRONG_TRANSPORT('switchToWs()', kind),
  };
}

/** Resolve legacy entrypoints only when the owning registration is unambiguous. */
export function getEntrypointModuleId(
  container: Container,
  target: { readonly token: Token; readonly moduleId?: string },
): string | undefined {
  assertExecutionScopeActive(container);
  const owners = container.getOwnerModuleIds(target.token);
  if (target.moduleId !== undefined) {
    if (!owners.includes(target.moduleId)) {
      throw new Error(`Entrypoint owner '${target.moduleId}' does not register its token.`);
    }
    return target.moduleId;
  }
  if (owners.length > 1) {
    throw new Error('Entrypoint token has multiple module owners; supply moduleId.');
  }
  return owners[0];
}

/** Preserve token inference while materializing the exact owning module asynchronously. */
export function resolveEntrypoint<K extends Token>(
  container: Container,
  target: { readonly token: K; readonly moduleId?: string },
): Promise<InferToken<K>> {
  return container.resolveAsync(target.token, getEntrypointModuleId(container, target));
}
