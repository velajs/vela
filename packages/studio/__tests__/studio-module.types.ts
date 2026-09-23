import { InjectionToken } from '@velajs/vela';
import { StudioModule } from '../src';

/** Compile-only checks: factory types require the actual runtime dependency tuple. */
export function studioAsyncModuleTypes(): void {
  const secret = new InjectionToken<string>('studio-typecheck-secret');
  StudioModule.forRootAsync({ inject: [], useFactory: () => ({ token: 'secret' }) });
  StudioModule.forRootAsync({ inject: [secret], useFactory: (token) => ({ token }) });
  // A factory without parameters may omit its dependency tuple.
  StudioModule.forRootAsync({ useFactory: () => ({ token: 'secret' }) });

  // @ts-expect-error A factory with parameters names the tokens that supply them.
  StudioModule.forRootAsync({ useFactory: (token: string) => ({ token }) });
  // @ts-expect-error A caller-only generic cannot supply missing runtime dependencies.
  StudioModule.forRootAsync<[typeof secret]>({ useFactory: (token) => ({ token }) });
}
