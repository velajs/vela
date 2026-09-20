import { InjectionToken } from '@velajs/vela';
import { StudioModule } from '../src';

/** Compile-only checks: factory types require the actual runtime dependency tuple. */
export function studioAsyncModuleTypes(): void {
  const secret = new InjectionToken<string>('studio-typecheck-secret');
  StudioModule.forRootAsync({ inject: [], useFactory: () => ({ token: 'secret' }) });
  StudioModule.forRootAsync({ inject: [secret], useFactory: (token) => ({ token }) });

  // @ts-expect-error Even a zero-dependency factory must declare its runtime tuple.
  StudioModule.forRootAsync({ useFactory: () => ({ token: 'secret' }) });
  // @ts-expect-error A caller-only generic cannot supply missing runtime dependencies.
  StudioModule.forRootAsync<[typeof secret]>({ useFactory: (token) => ({ token }) });
}
