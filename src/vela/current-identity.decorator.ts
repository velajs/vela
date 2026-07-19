import {
  createParamDecorator,
  REQUEST_CONTEXT,
  type ExecutionContext,
  type RequestContext,
} from '@velajs/vela';
import type { ResolvedIdentity } from '../types';
import { ACCESS_IDENTITY_KEY } from './tokens';

/** The per-request DI container, reached via the Hono context. */
interface ContainerLike {
  resolve<T>(token: unknown): T;
}

/**
 * Parameter decorator that yields the verified Access identity
 * {@link CloudflareAccessGuard} stashed for the request, or `undefined` when the
 * caller is anonymous (optional mode).
 *
 * ```ts
 * @Get()
 * me(@CurrentAccessIdentity() identity?: ResolvedIdentity) {}
 * ```
 */
export const CurrentAccessIdentity = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const reqCtx = context
      .getContext<{ get(key: 'container'): ContainerLike }>()
      .get('container')
      .resolve<RequestContext>(REQUEST_CONTEXT);
    return reqCtx.get<ResolvedIdentity>(ACCESS_IDENTITY_KEY);
  },
);
