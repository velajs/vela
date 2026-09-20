import type { Container } from '../container/container';
import type { Type } from '../container/types';
import type { ExecutionContext } from '../pipeline/types';

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
    getHandler: () => handlerName,
    getModuleId: () => moduleId,
    getContainer: () => container,
    getPayload: () => payload,
    getContext: WRONG_TRANSPORT('getContext()', kind),
    getRequest: WRONG_TRANSPORT('getRequest()', kind),
    switchToHttp: WRONG_TRANSPORT('switchToHttp()', kind),
    switchToWs: WRONG_TRANSPORT('switchToWs()', kind),
  };
}
