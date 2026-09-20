import type { Context } from 'hono';
import type { Container } from '../container/container';
import { buildEntrypointExecutionContext } from '../entrypoint/execution-context';
import type { ExecutionContext, HttpExecutionContext, WsArgumentsHost } from '../pipeline/types';
import type { WsClient, WsExecutionContext } from '../websocket/websocket.types';

// Included by the normal core tsconfig: these exported, uncalled functions
// verify public contracts without evaluating intentionally invalid accesses.
export function verifyHttpContextTypes(context: HttpExecutionContext): void {
  const request: Request = context.switchToHttp().getRequest();
  const response: Context = context.switchToHttp().getResponse();
  const hono: Context = context.getContext();
  const container: Container | undefined = context.getContainer();
  const kind: 'http' = context.getType();
  void [request, response, hono, container, kind];

  // @ts-expect-error Raw Hono variables are unknown, never unverified typed values.
  const counter: number = context.getContext().get('counter');
  // @ts-expect-error Platform binding types come from the configured Env token.
  context.getContext().env.DB.prepare('select 1');
  void counter;

  // @ts-expect-error HTTP requests cannot be retyped by callers.
  context.switchToHttp().getRequest<Date>();
  // @ts-expect-error The actual Request is not a Date.
  const date: Date = context.switchToHttp().getRequest();
  // @ts-expect-error A context cannot claim an unrelated execution kind.
  context.getType<'queue'>();
  // @ts-expect-error This concrete builder represents HTTP, never a queue.
  const queue: 'queue' = context.getType();
  // @ts-expect-error Hono response handles cannot be retyped by callers.
  context.switchToHttp().getResponse<Date>();
  // @ts-expect-error The context accessor returns Hono's Context.
  context.getContext<Date>();
  // @ts-expect-error The container accessor returns the framework Container.
  context.getContainer<Date>();
  void [date, queue];
}

export function verifyWsContextTypes(context: WsExecutionContext, host: WsArgumentsHost): void {
  const kind: 'ws' = context.getType();
  const client: WsClient = host.getClient();
  const pattern: string = host.getPattern();
  const data: unknown = host.getData();
  void [kind, client, pattern, data];

  // @ts-expect-error The transport owns the client type.
  host.getClient<Date>();
  // @ts-expect-error Inbound payloads require validation, not a type argument.
  host.getData<{ authenticated: true }>();
  // @ts-expect-error Event names are strings, not caller-selected types.
  host.getPattern<number>();
  // @ts-expect-error Unknown payloads cannot be consumed as validated data.
  const validated: { authenticated: true } = host.getData();
  void validated;
}

export function verifyCustomEntrypointTypes(context: ExecutionContext): void {
  class ScheduledHandler {
    tick(): void {}
  }
  const entrypoint = buildEntrypointExecutionContext(
    'adapter:scheduled',
    ScheduledHandler,
    'tick',
    { scheduledTime: 123 },
  );
  const kind: 'adapter:scheduled' = entrypoint.getType();
  const payload: unknown = entrypoint.getPayload();
  void [kind, payload];

  // @ts-expect-error A generic context's runtime kind must be checked first.
  const queue: 'queue' = context.getType();
  // @ts-expect-error Custom payloads require validation at the dispatch boundary.
  entrypoint.getPayload<Date>();
  void queue;
}
