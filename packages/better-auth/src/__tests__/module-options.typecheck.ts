import { InjectionToken } from '@velajs/vela';
import { BetterAuthModule } from '../better-auth.module';
import type { BetterAuthInstance } from '../better-auth.types';

// Compile-only checks: the factory's dependency types come from its inject tuple.
const AUTH = new InjectionToken<BetterAuthInstance>('typecheck.auth');
declare const auth: BetterAuthInstance;

BetterAuthModule.forRootAsync({ inject: [AUTH], useFactory: (instance) => ({ auth: instance }) });
BetterAuthModule.forRootAsync({ inject: [], useFactory: () => ({ auth: () => auth }) });
// A factory without parameters may omit its dependency tuple; structural
// options travel alongside it.
BetterAuthModule.forRootAsync({
  useFactory: () => ({ auth, issuer: 'accounts' }),
  basePath: '/auth',
  globalGuard: false,
});
BetterAuthModule.forRoot({ auth: () => auth, isGlobal: true });

BetterAuthModule.forRootAsync({
  // @ts-expect-error A factory with parameters names the tokens that supply them.
  useFactory: (instance: BetterAuthInstance) => ({ auth: instance }),
});
// @ts-expect-error A caller-only dependency tuple cannot supply runtime tokens.
BetterAuthModule.forRootAsync<readonly [typeof AUTH]>({ useFactory: () => ({ auth }) });
BetterAuthModule.forRootAsync({
  inject: [AUTH],
  // @ts-expect-error The factory must match its injected token.
  useFactory: (instance: string) => ({ auth: { ...auth, instance } }),
});
// @ts-expect-error The factory returns module options, not the bare instance.
BetterAuthModule.forRootAsync({ useFactory: () => auth });
// @ts-expect-error The issuer is resolved by the factory, not passed at the call site.
BetterAuthModule.forRootAsync({ issuer: 'accounts', useFactory: () => ({ auth }) });
