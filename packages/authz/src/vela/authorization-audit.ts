import { Reflector, type CanActivate, type Token, type Type } from '@velajs/vela';
import {
  getScopedComponents,
  type AdapterContext,
  type RuntimeAdapter,
} from '@velajs/vela/module-kit';
import { AUTHZ } from './tokens';
import { RequirePermission } from './require-permission.decorator';
import { Roles } from './roles.decorator';
import { PermissionGuard } from './permission.guard';
import { RolesGuard } from './roles.guard';

export interface AuthorizationWiringDiagnostic {
  readonly code:
    | 'permission-guard-unverified'
    | 'roles-guard-unverified'
    | 'authz-missing'
    | 'authz-ambiguous';
  readonly controller: Type;
  readonly moduleId: string;
  readonly handler: string | symbol;
  readonly message: string;
}

export interface AuthorizationAuditOptions {
  /** Opt-in adapter defaults to rejecting incomplete/unverifiable wiring. */
  mode?: 'error' | 'warn';
  onDiagnostic?: (diagnostic: AuthorizationWiringDiagnostic) => void;
}

type AuditContext = Pick<AdapterContext, 'container' | 'routeManager'>;

function isGuardInstance(value: CanActivate | Token): value is CanActivate {
  return typeof value === 'object' && value !== null && 'canActivate' in value;
}

function isBuiltInInstance(value: unknown, required: Type<CanActivate>): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === required.prototype &&
    !Object.hasOwn(value, 'canActivate')
  );
}

/** Inspect registered implementation identity; never execute a provider factory. */
function hasGuard(
  reference: CanActivate | Token,
  required: Type<CanActivate>,
  container: AdapterContext['container'],
  moduleId?: string,
  seen: ReadonlyMap<string, ReadonlySet<Token>> = new Map(),
  directReference = true,
): boolean {
  if (isGuardInstance(reference)) return isBuiltInInstance(reference, required);
  const candidates = container.getVisibleProviderSnapshots(reference, moduleId);
  // Unregistered scoped guard classes are constructed by the normal pipeline.
  if (candidates.length === 0) return directReference && reference === required;
  if (candidates.length !== 1) return false;
  const candidate = candidates[0]!;
  if (seen.get(candidate.moduleId)?.has(candidate.token)) return false;
  if (candidate.instance) return isBuiltInInstance(candidate.instance.value, required);
  if (candidate.useClass) return candidate.useClass === required;
  if (candidate.useExisting) {
    const next = new Map(seen);
    next.set(
      candidate.moduleId,
      new Set([...(seen.get(candidate.moduleId) ?? []), candidate.token]),
    );
    return hasGuard(candidate.useExisting, required, container, candidate.moduleId, next, false);
  }
  // An unresolved factory cannot be proven to supply either built-in guard.
  return false;
}

/**
 * Inspect mounted HTTP handlers using their actual declaring module. This does
 * not audit arbitrary middleware, custom policy implementations, or non-HTTP
 * dispatchers. Runtime guards remain authoritative, including after startup.
 */
export function inspectAuthorizationWiring(
  context: AuditContext,
): readonly AuthorizationWiringDiagnostic[] {
  const diagnostics: AuthorizationWiringDiagnostic[] = [];
  const reflector = new Reflector();
  const globals = context.routeManager.getGlobalComponents().guards;
  for (const { controller, moduleId, routes } of context.routeManager.getControllers()) {
    const handlers = new Set(routes.map((route) => route.handlerName));
    for (const handler of handlers) {
      const diagnose = (code: AuthorizationWiringDiagnostic['code'], detail: string): void => {
        diagnostics.push(
          Object.freeze({
            code,
            controller,
            moduleId,
            handler,
            message: `${controller.name}.${String(handler)} (${moduleId}): ${detail}`,
          }),
        );
      };
      const scoped = getScopedComponents('guard', controller, handler, context.container, moduleId);
      const wired = (guard: Type<CanActivate>) =>
        globals.some((ref) => hasGuard(ref, guard, context.container)) ||
        scoped.some((ref) => hasGuard(ref, guard, context.container, moduleId));
      // Reads each requirement as the guards do, including a method
      // declaration the controller inherits.
      const route = { getClass: () => controller, getHandlerName: () => handler };
      const requirements = (key: string): boolean => {
        const value = reflector.getAllAndOverride(key, route);
        return Array.isArray(value) && value.length > 0;
      };
      if (requirements(RequirePermission.KEY)) {
        if (!wired(PermissionGuard))
          diagnose(
            'permission-guard-unverified',
            'RequirePermission has no verifiable PermissionGuard; opaque factories/custom guards require separate review',
          );
        const engines = context.container.getVisibleProviderSnapshots(AUTHZ, moduleId);
        if (engines.length === 0) diagnose('authz-missing', 'No module-visible AUTHZ provider');
        else if (engines.length !== 1)
          diagnose('authz-ambiguous', 'Multiple module-visible AUTHZ providers');
      }
      if (requirements(Roles.KEY) && !wired(RolesGuard))
        diagnose(
          'roles-guard-unverified',
          'Roles has no verifiable RolesGuard; opaque factories/custom guards require separate review',
        );
    }
  }
  return Object.freeze(diagnostics);
}

/** Opt-in startup diagnostics after HTTP routes and global guards are configured. */
export function authorizationAudit(options: AuthorizationAuditOptions = {}): RuntimeAdapter {
  const mode = options.mode ?? 'error';
  if (mode !== 'error' && mode !== 'warn') throw new TypeError('Invalid authorization audit mode');
  const onDiagnostic = options.onDiagnostic;
  if (onDiagnostic !== undefined && typeof onDiagnostic !== 'function')
    throw new TypeError('Authorization audit onDiagnostic must be a function');
  return {
    name: 'authorization-audit',
    onRoutesBuilt(context) {
      const diagnostics = inspectAuthorizationWiring(context);
      for (const diagnostic of diagnostics) onDiagnostic?.(diagnostic);
      if (diagnostics.length === 0) return;
      const message = `Authorization wiring audit failed:\n${diagnostics.map((d) => d.message).join('\n')}`;
      if (mode === 'error') throw new Error(message);
      if (!onDiagnostic) console.warn(message);
    },
  };
}
