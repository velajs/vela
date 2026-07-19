import { createParamDecorator, type ExecutionContext } from '@velajs/vela';
import { getAuthRequestState } from '../auth-request-state';
import type { User } from '../better-auth.types';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): User | undefined => {
    const state = getAuthRequestState(ctx);
    return state.authenticated ? state.user : undefined;
  },
);
