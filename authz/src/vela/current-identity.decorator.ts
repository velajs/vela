import { createParamDecorator, type ExecutionContext } from '@velajs/vela';
import { getContextIdentity } from './context-identity';

/** The same verified identity consumed by authorization and core throttling. */
export const CurrentIdentity = createParamDecorator((_data: unknown, context: ExecutionContext) =>
  getContextIdentity(context),
);
