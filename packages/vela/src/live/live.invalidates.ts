import { COMMIT_CURSOR_HEADER, COMMIT_EPOCH_HEADER } from '@velajs/live-protocol';
import { UseInterceptors } from '../pipeline/decorators';
import type { CallHandler, ExecutionContext, NestInterceptor } from '../pipeline/types';
import { LiveInvalidation, stampCommitHeaders } from './live.invalidation';
import type { CommitStamp } from './live.types';

/** Static tags, or tags derived from the handler's result. */
export type LiveInvalidatesTags<Result> =
  | readonly string[]
  | ((result: Result, context: ExecutionContext) => readonly string[]);

export interface LiveInvalidatesOptions<Result = unknown> {
  /**
   * The room whose subscriptions re-run; its log scope stamps the commit.
   * Omitted, the live driver's default room.
   */
  room?: string | ((result: Result, context: ExecutionContext) => string | undefined);
}

/** A stamped copy of a Response the handler returned itself. */
function withCommitHeaders(response: Response, stamp: CommitStamp): Response {
  const stamped = new Response(response.body, response);
  stamped.headers.set(COMMIT_CURSOR_HEADER, String(stamp.cursor));
  stamped.headers.set(COMMIT_EPOCH_HEADER, stamp.epoch);
  return stamped;
}

async function resolveInvalidation(context: ExecutionContext): Promise<LiveInvalidation> {
  const container = context.getContainer();
  const owner = context.getClass().name;
  if (!container) {
    throw new Error(`@LiveInvalidates on ${owner} runs only inside a Vela-managed handler.`);
  }
  try {
    return await container.resolveAsync(LiveInvalidation, context.getModuleId());
  } catch (error) {
    throw new Error(
      `@LiveInvalidates on ${owner} needs LiveInvalidation: import LiveModule.forRoot() ` +
        `from @velajs/vela/live into the module that declares ${owner}.`,
      { cause: error },
    );
  }
}

class LiveInvalidatesInterceptor<Result> implements NestInterceptor {
  constructor(
    private readonly tags: LiveInvalidatesTags<Result>,
    private readonly options: LiveInvalidatesOptions<Result>,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    // Resolve first: a module that cannot reach LiveModule fails before the
    // handler commits a write nobody would be told about.
    const invalidation = await resolveInvalidation(context);
    // The declaring decorator binds `Result` to this handler's awaited return type.
    const result = (await next.handle()) as Result;
    const tags = typeof this.tags === 'function' ? this.tags(result, context) : this.tags;
    if (tags.length === 0) return result;
    const { room } = this.options;
    const target = typeof room === 'function' ? room(result, context) : room;
    const stamp = await invalidation.invalidate({
      tags: [...tags],
      ...(target === undefined ? {} : { room: target }),
    });
    if (!stamp || context.getType() !== 'http') return result;
    if (result instanceof Response) return withCommitHeaders(result, stamp);
    stampCommitHeaders(context.switchToHttp().getResponse(), stamp);
    return result;
  }
}

/**
 * Invalidates live-query tags after the decorated handler succeeds, and
 * stamps the commit (`Vela-Commit-Cursor` / `Vela-Commit-Epoch`) on its HTTP
 * response, which the client's optimistic updates wait for:
 *
 * ```ts
 * @Post()
 * @LiveInvalidates(['todos'])
 * create(@Body(CreateTodo) body: CreateTodo) {
 *   return this.todos.add(body);
 * }
 *
 * @Delete('/:id')
 * @LiveInvalidates((result: { removed: boolean }) => (result.removed ? ['todos'] : []))
 * remove(@Param('id') id: string) {
 *   return this.todos.remove(id);
 * }
 * ```
 *
 * A handler that throws invalidates nothing, and a tags callback that returns
 * no tags skips the invalidation. The interceptor resolves `LiveInvalidation`
 * from the module that declares the controller, so that module must reach
 * `LiveModule`. On a WebSocket gateway handler it invalidates without
 * stamping.
 */
export function LiveInvalidates<Result = unknown>(
  tags: LiveInvalidatesTags<Result>,
  options: LiveInvalidatesOptions<Result> = {},
): <Handler extends (...args: never[]) => Result | Promise<Result>>(
  target: object,
  propertyKey: string | symbol,
  descriptor: TypedPropertyDescriptor<Handler>,
) => void {
  const interceptor = new LiveInvalidatesInterceptor(tags, options);
  return (target, propertyKey) => {
    UseInterceptors(interceptor)(target, propertyKey);
  };
}
