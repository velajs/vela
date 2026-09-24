import {
  Inject,
  InjectionToken,
  Injectable,
  Reflector,
  ForbiddenException,
  APP_GUARD,
  defineModule,
  defineProvider,
  type CanActivate,
  type ExecutionContext,
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
  /** Default true. Disable to order CedarGuard after route authentication/tenant guards. */
  globalGuard?: boolean;
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
/** Opt-in module audit. Inherited class declarations apply to all its handlers. */
export function auditCedarRoutes(modules: readonly Type[]): void {
  for (const module of modules) {
    const metadata = MetadataRegistry.getModuleOptions(module);
    if (!metadata) throw new Error(`Cannot audit non-module '${module.name}'`);
    for (const controller of metadata.controllers ?? []) {
      for (const route of MetadataRegistry.getRoutes(controller)) {
        const value =
          MetadataRegistry.getCustomHandlerMeta(controller, route.handlerName, declaration.KEY) ??
          MetadataRegistry.getCustomClassMeta(controller, declaration.KEY);
        if (value === undefined)
          throw new Error(
            `Authorization declaration missing: ${controller.name}.${String(route.handlerName)}`,
          );
      }
    }
  }
}
export class CedarGuard implements CanActivate {
  readonly #reflector: Reflector;
  constructor(reflector: Reflector) {
    this.#reflector = reflector;
  }
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const declared = this.#reflector.getAllAndOverride(declaration, context);
    if (!declared || declared.kind === 'public') return true;
    const moduleId = context.getModuleId(),
      container = context.getContainer();
    if (!moduleId || !container) throw new ForbiddenException();
    const candidates = container.resolveAll(CEDAR_AUTHORIZER, moduleId);
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
const { ConfigurableModuleClass } = defineModule<CedarModuleOptions>({
  name: 'CedarAuthorization',
  setup: ({ OPTIONS }) => ({
    providers: [
      defineProvider(CEDAR_AUTHORIZER, {
        inject: [OPTIONS],
        useFactory: (options) => {
          auditCedarRoutes(options.auditModules ?? []);
          return options;
        },
      }),
      CedarGuard,
      defineProvider(APP_GUARD, {
        inject: [OPTIONS, CedarGuard],
        useFactory: (options, guard) =>
          options.globalGuard === false ? { canActivate: () => true } : guard,
      }),
    ],
    exports: [CEDAR_AUTHORIZER, CedarGuard],
  }),
});
export class CedarModule extends ConfigurableModuleClass {}
