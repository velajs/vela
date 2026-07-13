import {
  createLazyParamDecorator,
  REQUEST_CONTEXT,
  type ExecutionContext,
  type RequestContext,
} from '@velajs/vela';
import { AUTH_SESSION_KEY } from '../better-auth.tokens';
import type { Session } from '../better-auth.types';

export const CurrentSession = createLazyParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const honoCtx = ctx.getContext() as { get: (k: string) => { resolve<T>(t: unknown): T } };
  const reqCtx = honoCtx.get('container').resolve<RequestContext>(REQUEST_CONTEXT);
  return reqCtx.get<Session>(AUTH_SESSION_KEY);
});
