import { defineProvider } from '../container/types';
import { RouteManager } from '../http/route.manager';
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
      defineProvider(APP_MIDDLEWARE, {
        useFactory: (options: SecurityModuleOptions, routes: RouteManager) => {
          // Its preflight policy runs after the framework's CORS middleware,
          // which would answer first, so only one of them may serve CORS.
          if (options.cors !== false) routes.reserveCors("SecurityModule's cors option");
          return buildSecurityMiddleware(options);
        },
        inject: [OPTIONS, RouteManager],
      }),
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
