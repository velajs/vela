import { defineModule } from '../module/define-module';
import { APP_MIDDLEWARE } from '../pipeline/tokens';
import type { DynamicModule } from '../registry/types';
import { SECURITY_OPTIONS } from './security.tokens';
import type { SecurityModuleOptions } from './security.types';
import { buildSecurityMiddleware } from './security.middleware';

const { ConfigurableModuleClass } = defineModule<SecurityModuleOptions>({
  name: 'Security',
  optionsToken: SECURITY_OPTIONS,
  setup: ({ OPTIONS }) => ({
    providers: [
      {
        provide: APP_MIDDLEWARE,
        useFactory: (options: SecurityModuleOptions) => buildSecurityMiddleware(options),
        inject: [OPTIONS],
      },
    ],
    exports: [OPTIONS],
  }),
});

const baseForRoot = ConfigurableModuleClass.forRoot;

export class SecurityModule extends ConfigurableModuleClass {
  /** Validate synchronous security policy at declaration time, before bootstrap can swallow provider errors. */
  static forRoot(
    options: SecurityModuleOptions & { isGlobal?: boolean; key?: string } = {},
  ): DynamicModule {
    buildSecurityMiddleware(options);
    return Reflect.apply(baseForRoot, this, [options]) as DynamicModule;
  }
}
