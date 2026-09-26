import {
  Inject,
  InjectionToken,
  Injectable,
  ModuleRef,
  Reflector,
  ForbiddenException,
  defineModule,
  defineProvider,
  type CanActivate,
  type ExecutionContext,
  type GuardPhase,
  type Type,
} from '@velajs/vela';
import {
  MetadataRegistry,
  getTrustedRequestIdentity,
  type TrustedRequestIdentity,
} from '@velajs/vela/module-kit';
export interface ResourceRequirement {
  readonly action: string;
  readonly resourceType: string;
  readonly idParam?: string;
}
type Declaration = { kind: 'public' } | { kind: 'authorize'; requirement: ResourceRequirement };
const declaration = Reflector.createDecorator<Declaration>({ key: 'vela.cedar.authorization' });
export const CedarPublic = () => declaration({ kind: 'public' });
export const RequireResource = (requirement: ResourceRequirement) =>
  declaration({ kind: 'authorize', requirement: Object.freeze({ ...requirement }) });
export interface CedarModuleOptions {
  /**
   * Routes without `@RequireResource` or `@CedarPublic`: `'deny'` (default)
   * rejects them with 403; `'allow'` lets them through. Async factories may
   * resolve this policy through injected configuration.
   */
  undeclared?: 'deny' | 'allow';
  /** Resolve resources/grants from trusted application services; invoke engine.check here. */
  authorize(input: {
    requirement: ResourceRequirement;
    context: ExecutionContext;
    identity: TrustedRequestIdentity;
  }): Promise<boolean>;
  /** Transport adapters must verify queue/scheduled/socket credentials before returning identity. */
  identity?: (context: ExecutionContext) => TrustedRequestIdentity | undefined;
  auditModules?: readonly Type[];
}
export const CEDAR_AUTHORIZER = new InjectionToken<CedarModuleOptions>('vela.cedar.authorizer');
/**
 * Opt-in module audit. A class declaration applies to all its handlers; a
 * method declaration applies where the controller routes that method,
 * including one it inherits unchanged. It reads declarations as `CedarGuard` does.
 */
export function auditCedarRoutes(modules: readonly Type[]): void {
  const reflector = new Reflector();
  for (const module of modules) {
    const metadata = MetadataRegistry.getModuleOptions(module);
    if (!metadata) throw new Error(`Cannot audit non-module '${module.name}'`);
    for (const controller of metadata.controllers ?? []) {
      for (const route of MetadataRegistry.getRoutes(controller)) {
        const value = reflector.getAllAndOverride(declaration, {
          getClass: () => controller,
          getHandlerName: () => route.handlerName,
        });
        if (value === undefined)
          throw new Error(
            `Authorization declaration missing: ${controller.name}.${String(route.handlerName)}`,
          );
      }
    }
  }
}
// Exported configured guards retain the module each belongs to.
const configuredHosts = new WeakMap<CedarGuard, ModuleRef>();

export class CedarGuard implements CanActivate {
  /** Global guards authorize after authentication and tenant admission. */
  static readonly phase: GuardPhase = 'authorize';
  /**
   * Integration routes marked `SkipGuardPhases(['authorize'])` authorize
   * themselves. A subclass declares `false` to run on them too.
   */
  static readonly skippable: boolean = true;
  readonly #reflector: Reflector;
  constructor(reflector: Reflector) {
    this.#reflector = reflector;
  }
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const declared = this.#reflector.getAllAndOverride(declaration, context);
    if (declared?.kind === 'public') return true;
    const moduleId = context.getModuleId(),
      container = context.getContainer();
    let candidates = moduleId && container ? container.resolveAll(CEDAR_AUTHORIZER, moduleId) : [];
    // A configured guard may cover every application route: where the
    // route's module does not import CedarModule, its own module's policy
    // applies. A route-level CedarGuard there has no policy and denies.
    const host = configuredHosts.get(this);
    if (candidates.length === 0 && host) candidates = [await host.resolve(CEDAR_AUTHORIZER)];
    if (!declared) {
      if (candidates.length === 1 && candidates[0]!.undeclared === 'allow') return true;
      throw new ForbiddenException();
    }
    if (!moduleId || !container) throw new ForbiddenException();
    if (candidates.length !== 1) throw new ForbiddenException('Cedar configuration is ambiguous');
    const options = candidates[0]!;
    const read = () =>
      context.getType() === 'http'
        ? getTrustedRequestIdentity(context.getRequest())
        : options.identity?.(context);
    const identity = read();
    if (!identity || (identity.expiresAtMs !== undefined && identity.expiresAtMs <= Date.now()))
      throw new ForbiddenException();
    if (
      (await options.authorize({ requirement: declared.requirement, context, identity })) !== true
    )
      throw new ForbiddenException();
    const current = read();
    if (
      !current ||
      (context.getType() === 'http' && current !== identity) ||
      current.principal.issuer !== identity.principal.issuer ||
      current.principal.subject !== identity.principal.subject ||
      current.principal.principalType !== identity.principal.principalType ||
      current.tenantId !== identity.tenantId ||
      current.expiresAtMs !== identity.expiresAtMs ||
      (current.expiresAtMs !== undefined && current.expiresAtMs <= Date.now())
    )
      throw new ForbiddenException();
    return true;
  }
}
Injectable()(CedarGuard);
Inject(Reflector)(CedarGuard, undefined, 0);
/** The module-owned guard applications can alias through APP_GUARD. */
class ConfiguredCedarGuard extends CedarGuard {
  constructor(reflector: Reflector, host: ModuleRef) {
    super(reflector);
    configuredHosts.set(this, host);
  }
}
Injectable()(ConfiguredCedarGuard);
Inject(Reflector)(ConfiguredCedarGuard, undefined, 0);
Inject(ModuleRef)(ConfiguredCedarGuard, undefined, 1);
const { ConfigurableModuleClass } = defineModule<CedarModuleOptions>({
  name: 'CedarAuthorization',
  setup: ({ OPTIONS }) => ({
    providers: [
      defineProvider(CEDAR_AUTHORIZER, {
        inject: [OPTIONS],
        useFactory: (resolved) => {
          const undeclared = resolved.undeclared ?? 'deny';
          if (undeclared !== 'deny' && undeclared !== 'allow')
            throw new TypeError("CedarModule undeclared must be 'deny' or 'allow'");
          auditCedarRoutes(resolved.auditModules ?? []);
          return { ...resolved, undeclared };
        },
      }),
      defineProvider(CedarGuard, { useClass: ConfiguredCedarGuard }),
    ],
    exports: [CEDAR_AUTHORIZER, CedarGuard],
  }),
});
export class CedarModule extends ConfigurableModuleClass {}
