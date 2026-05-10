// Module
export { BetterAuthModule } from './better-auth.module';
export { BetterAuthCatchallController } from './better-auth.controller';

// Tokens & symbols
export {
  BETTER_AUTH,
  BETTER_AUTH_OPTIONS,
  AUTH_USER_KEY,
  AUTH_SESSION_KEY,
} from './better-auth.tokens';

// Guards
export { AuthGuard } from './guards/auth.guard';
export { RolesGuard } from './guards/roles.guard';

// Decorators
export { CurrentUser } from './decorators/current-user.decorator';
export { CurrentSession } from './decorators/current-session.decorator';
export { Public, PUBLIC_KEY } from './decorators/public.decorator';
export { OptionalAuth, OPTIONAL_AUTH_KEY } from './decorators/optional-auth.decorator';
export { Roles, ROLES_KEY } from './decorators/roles.decorator';

// Types
export type {
  BetterAuthInstance,
  BetterAuthModuleOptions,
  Session,
  User,
} from './better-auth.types';
