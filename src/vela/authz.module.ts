import { defineModule } from '@velajs/vela';
import { createAuthz } from '../authz';
import type { CreateAuthzOptions } from '../authz';
import { AUTHZ, AUTHZ_OPTIONS } from './tokens';

/**
 * Built on `@velajs/vela`'s `defineModule` engine (the same pattern as vela's
 * own `ErrorsModule`). `defineModule` mints the `forRoot`/`forRootAsync`
 * statics and auto-provides the options bag under {@link AUTHZ_OPTIONS}; `setup`
 * turns those options into the built {@link AUTHZ} instance and exports it.
 */
const { ConfigurableModuleClass } = defineModule<CreateAuthzOptions>({
  name: 'Authz',
  // Reuse the public AUTHZ_OPTIONS token for the auto-provided options bag,
  // kept DISTINCT from the AUTHZ instance token below.
  optionsToken: AUTHZ_OPTIONS,
  setup: ({ options }) => ({
    providers: [{ provide: AUTHZ, useValue: createAuthz(options) }],
    exports: [AUTHZ],
  }),
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
