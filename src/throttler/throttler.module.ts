import type { ProviderOptions, Type } from '../container/types';
import type { AsyncModuleOptions, DynamicModule } from '../module/types';
import { APP_GUARD } from '../pipeline/tokens';
import { ThrottlerGuard } from './throttler.guard';
import { ThrottlerStorage } from './throttler.storage';
import { THROTTLER_OPTIONS, THROTTLER_STORAGE } from './throttler.tokens';
import type { ThrottlerModuleOptions } from './throttler.types';

export class ThrottlerModule {
  static forRoot(options: ThrottlerModuleOptions): DynamicModule {
    const providers: Array<Type | ProviderOptions> = [
      { provide: THROTTLER_OPTIONS, useValue: options },
      { provide: THROTTLER_STORAGE, useValue: options.storage ?? new ThrottlerStorage() },
      ThrottlerGuard,
      { provide: APP_GUARD, useExisting: ThrottlerGuard },
    ];

    return {
      module: ThrottlerModule,
      providers,
      exports: [THROTTLER_OPTIONS, THROTTLER_STORAGE, ThrottlerGuard],
    };
  }

  static forRootAsync(options: AsyncModuleOptions<ThrottlerModuleOptions>): DynamicModule {
    const providers: Array<Type | ProviderOptions> = [
      {
        provide: THROTTLER_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      },
      {
        provide: THROTTLER_STORAGE,
        useFactory: (opts: ThrottlerModuleOptions) => opts.storage ?? new ThrottlerStorage(),
        inject: [THROTTLER_OPTIONS],
      },
      ThrottlerGuard,
      { provide: APP_GUARD, useExisting: ThrottlerGuard },
    ];

    return {
      module: ThrottlerModule,
      imports: options.imports ?? [],
      providers,
      exports: [THROTTLER_OPTIONS, THROTTLER_STORAGE, ThrottlerGuard],
    };
  }
}
