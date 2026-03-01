import { METADATA_KEYS } from '../constants';
import { defineMetadata } from '../metadata';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Type, ProviderOptions } from '../container/types';
import type { AsyncModuleOptions, DynamicModule } from '../module/types';
import { APP_GUARD } from '../pipeline/tokens';
import { ThrottlerGuard } from './throttler.guard';
import { ThrottlerStorage } from './throttler.storage';
import { THROTTLER_OPTIONS, THROTTLER_STORAGE } from './throttler.tokens';
import type { ThrottlerModuleOptions } from './throttler.types';

function makeThrottlerModuleClass() {
  const moduleClass = class ThrottlerDynamicModule {} as unknown as Type;
  Object.defineProperty(moduleClass, 'name', { value: 'ThrottlerModule' });
  defineMetadata(METADATA_KEYS.MODULE, true, moduleClass);
  return moduleClass;
}

export class ThrottlerModule {
  static forRoot(options: ThrottlerModuleOptions): DynamicModule {
    const moduleClass = makeThrottlerModuleClass();
    MetadataRegistry.setModuleOptions(moduleClass, {
      exports: [THROTTLER_OPTIONS, THROTTLER_STORAGE, ThrottlerGuard],
    });

    const providers: Array<Type | ProviderOptions> = [
      { token: THROTTLER_OPTIONS, useValue: options },
      { token: THROTTLER_STORAGE, useValue: options.storage ?? new ThrottlerStorage() },
      ThrottlerGuard,
      { token: APP_GUARD, useExisting: ThrottlerGuard },
    ];

    return { module: moduleClass, providers };
  }

  static forRootAsync(options: AsyncModuleOptions<ThrottlerModuleOptions>): DynamicModule {
    const moduleClass = makeThrottlerModuleClass();
    MetadataRegistry.setModuleOptions(moduleClass, {
      imports: options.imports ?? [],
      exports: [THROTTLER_OPTIONS, THROTTLER_STORAGE, ThrottlerGuard],
    });

    const providers: Array<Type | ProviderOptions> = [
      {
        token: THROTTLER_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      },
      {
        token: THROTTLER_STORAGE,
        useFactory: (opts: ThrottlerModuleOptions) => opts.storage ?? new ThrottlerStorage(),
        inject: [THROTTLER_OPTIONS],
      },
      ThrottlerGuard,
      { token: APP_GUARD, useExisting: ThrottlerGuard },
    ];

    return { module: moduleClass, providers };
  }
}
