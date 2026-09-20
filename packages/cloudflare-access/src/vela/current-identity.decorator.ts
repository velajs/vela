import { createParamDecorator, type ExecutionContext } from '@velajs/vela';
import { getAccessRequestIdentity } from './access-request-state';

/** Provider payload (including mapClaims enrichment) bound to the current core identity. */
export const CurrentAccessIdentity = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => getAccessRequestIdentity(context),
);
