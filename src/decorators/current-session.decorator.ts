import { createParamDecorator, type ExecutionContext } from '@velajs/vela';
import { getAuthRequestState } from '../auth-request-state';
import type { Session } from '../better-auth.types';

export const CurrentSession = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Session | undefined => {
    const state = getAuthRequestState(ctx);
    return state?.session;
  },
);
