// Module
export { BetterAuthModule } from './better-auth.module';
export { BetterAuthService } from './better-auth.service';
export { createBetterAuthCatchallController } from './better-auth.controller';

export { BETTER_AUTH_OPTIONS } from './better-auth.tokens';

// Guards
export { AuthGuard } from './guards/auth.guard';

// Decorators
export { CurrentUser } from './decorators/current-user.decorator';
export { CurrentSession } from './decorators/current-session.decorator';
export { Public, PUBLIC_KEY } from './decorators/public.decorator';
export { OptionalAuth, OPTIONAL_AUTH_KEY } from './decorators/optional-auth.decorator';
// Authz bridge (@velajs/authz)
export {
  BETTER_AUTH_ISSUER,
  identityFromUser,
  betterAuthAcResolver,
  permissionsFromAcRole,
} from './authz-bridge';
export type { AuthUser, BetterAuthAcRole } from './authz-bridge';

// Types
export type {
  BetterAuthInstance,
  BetterAuthModuleOptions,
  BetterAuthRuntimeOptions,
  Session,
  User,
} from './better-auth.types';
