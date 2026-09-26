import { Module, defineModule, defineProvider } from '@velajs/vela';
import { createAuthz } from '../authz';
import { PermissionGuard } from './permission.guard';
import { RolesGuard } from './roles.guard';
import { AUTHZ, AUTHZ_OPTIONS, type AuthzModuleOptions } from './tokens';

// Guards select the engine visible to each route. One shared provider owner
// keeps the guard itself unambiguous when a module imports multiple engines.
class AuthorizationGuardsModule {}
Module({ providers: [PermissionGuard, RolesGuard], exports: [PermissionGuard, RolesGuard] })(
  AuthorizationGuardsModule,
);

/**
 * Built on `@velajs/vela`'s `defineModule` engine (the same pattern as vela's
 * own `ErrorsModule`). `defineModule` mints the `forRoot`/`forRootAsync`
 * statics and auto-provides the options bag under {@link AUTHZ_OPTIONS}. The
 * authorization provider consumes the resolved bag so both entry points use
 * the same construction path, including DI-driven async options.
 */
const { ConfigurableModuleClass } = defineModule<AuthzModuleOptions>({
  name: 'Authz',
  // Reuse the public AUTHZ_OPTIONS token for the auto-provided options bag,
  // kept DISTINCT from the AUTHZ instance token below.
  optionsToken: AUTHZ_OPTIONS,
  setup: ({ OPTIONS }) => {
    return {
      imports: [AuthorizationGuardsModule],
      providers: [
        defineProvider(AUTHZ, {
          useFactory: ({ roles, permissions, resolver }: AuthzModuleOptions) =>
            createAuthz({
              ...(roles === undefined ? {} : { roles }),
              ...(permissions === undefined ? {} : { permissions }),
              ...(resolver === undefined ? {} : { resolver }),
            }),
          inject: [OPTIONS],
        }),
      ],
      exports: [AUTHZ, PermissionGuard, RolesGuard],
    };
  },
});

/**
 * Vela module for `@velajs/authz`. `AuthzModule.forRoot(options)` provides an
 * {@link Authz} instance (`createAuthz(options)`) under the {@link AUTHZ} token
 * and exports it for other modules to inject.
 *
 * ```ts
 * @Module({
 *   imports: [AuthzModule.forRoot({ roles: [defineRole('editor', ['posts:write'])] })],
 * })
 * class AppModule {}
 * ```
 */
export class AuthzModule extends ConfigurableModuleClass {}
