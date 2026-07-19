import type { Type } from '../container/types';
import type { ExecutionContext } from '../pipeline/types';

/** ExecutionContext flavor handed to components around entrypoint dispatch. */
export interface EntrypointExecutionContext extends ExecutionContext {
  /** The dispatch payload (queue batch, scheduled event, …). */
  getPayload<T = unknown>(): T;
}

const WRONG_TRANSPORT = (accessor: string, kind: string) => () => {
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
export function buildEntrypointExecutionContext(
  kind: string,
  targetClass: Type,
  handlerName: string | symbol,
  payload: unknown,
  moduleId?: string,
): EntrypointExecutionContext {
  return {
    getType: <T extends string>() => kind as T,
    getClass: () => targetClass,
    getHandler: () => handlerName,
    getModuleId: () => moduleId,
    getPayload: <T = unknown>() => payload as T,
    getContext: WRONG_TRANSPORT('getContext()', kind) as never,
    getRequest: WRONG_TRANSPORT('getRequest()', kind) as never,
    switchToHttp: WRONG_TRANSPORT('switchToHttp()', kind) as never,
    switchToWs: WRONG_TRANSPORT('switchToWs()', kind) as never,
  } as EntrypointExecutionContext;
}
