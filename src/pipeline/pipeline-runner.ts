import { ForbiddenException } from '../errors/http-exception';
import type {
  CallHandler,
  CanActivate,
  ExecutionContext,
  NestInterceptor,
} from './types';

export interface PipelineRunOptions {
  context: ExecutionContext;
  /** Pre-merged (global ++ scoped), pre-instantiated. */
  guards: CanActivate[];
  interceptors: NestInterceptor[];
  /** Extract handler arguments (pipes already bound inside the closure). */
  resolveArgs: () => Promise<unknown[]>;
  /** Call the actual handler. */
  invoke: (args: unknown[]) => Promise<unknown>;
  /**
   * HTTP runs argument extraction + pipes BEFORE guards (a deliberate vela
   * deviation — see handler-executor); WebSocket runs guards first. Default
   * false (guards first).
   */
  argsBeforeGuards?: boolean;
  /** Error thrown when a guard rejects (default `ForbiddenException`). */
  onGuardReject?: () => Error;
}

/**
 * The transport-agnostic guard → pipe → interceptor execution core shared by
 * the HTTP `HandlerExecutor` and the WebSocket `WsDispatcher` (and any future
 * entrypoint dispatcher: queue consumers, scheduled jobs, …). Exception
 * FILTERS stay with the caller — their terminal behavior is transport-specific
 * (HTTP maps to a Response, WS sends an error frame).
 */
export class PipelineRunner {
  static async run(options: PipelineRunOptions): Promise<unknown> {
    let args: unknown[] | undefined;

    if (options.argsBeforeGuards) {
      args = await options.resolveArgs();
    }

    for (const guard of options.guards) {
      const canActivate = await guard.canActivate(options.context);
      if (!canActivate) {
        throw options.onGuardReject?.() ?? new ForbiddenException();
      }
    }

    args ??= await options.resolveArgs();
    const resolvedArgs = args;

    return PipelineRunner.chainInterceptors(options.interceptors, options.context, () =>
      options.invoke(resolvedArgs),
    );
  }

  /** Interceptor onion — innermost is the core handler. */
  static async chainInterceptors(
    interceptors: NestInterceptor[],
    context: ExecutionContext,
    coreHandler: () => Promise<unknown>,
  ): Promise<unknown> {
    if (interceptors.length === 0) {
      return coreHandler();
    }

    let next: CallHandler = { handle: coreHandler };

    for (let i = interceptors.length - 1; i >= 0; i--) {
      const interceptor = interceptors[i];
      const currentNext = next;
      next = {
        handle: () => interceptor.intercept(context, currentNext),
      };
    }

    return next.handle();
  }
}
