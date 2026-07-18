// Module
export { BetterAuthModule } from './better-auth.module';
export { BetterAuthService } from './better-auth.service';
export {
  BetterAuthCatchallController,
  createBetterAuthCatchallController,
} from './better-auth.controller';

// Tokens & symbols
export {
  BETTER_AUTH_OPTIONS,
  AUTH_ISSUER_KEY,
  AUTH_PRINCIPAL_TYPE_KEY,
  AUTH_USER_KEY,
  AUTH_SESSION_KEY,
} from './better-auth.tokens';

// Guards
export { AuthGuard } from './guards/auth.guard';
export { RolesGuard } from './guards/roles.guard';
export { PermissionGuard } from './guards/permission.guard';

// Decorators
export { CurrentUser } from './decorators/current-user.decorator';
export { CurrentSession } from './decorators/current-session.decorator';
export { Public, PUBLIC_KEY } from './decorators/public.decorator';
export { OptionalAuth, OPTIONAL_AUTH_KEY } from './decorators/optional-auth.decorator';
export { Roles, ROLES_KEY } from './decorators/roles.decorator';
export {
  RequirePermission,
  REQUIRE_PERMISSION_KEY,
} from './decorators/require-permission.decorator';

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
  Session,
  User,
} from './better-auth.types';
