import { InjectionToken } from '@velajs/vela';
import { BetterAuthModule } from '../better-auth.module';
import type { BetterAuthInstance } from '../better-auth.types';

// Compile-only checks: the factory's dependency types come from its inject tuple.
const AUTH = new InjectionToken<BetterAuthInstance>('typecheck.auth');
declare const auth: BetterAuthInstance;

BetterAuthModule.forRootAsync({ inject: [AUTH], useFactory: (instance) => instance });
BetterAuthModule.forRootAsync({ inject: [], useFactory: () => auth });
// A factory without parameters may omit its dependency tuple.
BetterAuthModule.forRootAsync({ useFactory: () => auth, basePath: '/auth' });

// @ts-expect-error A factory with parameters names the tokens that supply them.
BetterAuthModule.forRootAsync({ useFactory: (instance: BetterAuthInstance) => instance });
// @ts-expect-error A caller-only dependency tuple cannot supply runtime tokens.
BetterAuthModule.forRootAsync<readonly [typeof AUTH]>({ useFactory: () => auth });
BetterAuthModule.forRootAsync({
  inject: [AUTH],
  // @ts-expect-error The factory must match its injected token.
  useFactory: (instance: string) => ({ ...auth, instance }),
});
