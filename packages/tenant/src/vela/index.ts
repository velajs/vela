import {
  Inject,
  Injectable,
  InjectionToken,
  REQUEST_CONTEXT,
  runInEntrypointScope,
  type Container,
  Scope,
  defineModule,
  defineProvider,
  createParamDecorator,
  Reflector,
  ForbiddenException,
  BadRequestException,
  getTrustedRequestIdentity,
  setTrustedRequestTenant,
  type CanActivate,
  type ExecutionContext,
} from '@velajs/vela';
import {
  TenantService,
  TenantError,
  headerTenant,
  type TenantSnapshot,
  type TenantContextReader,
  type TenantServiceOptions,
  type TenantSelector,
  type TenantRunOptions,
} from '../index';

export const TENANT_SERVICE = new InjectionToken<TenantService>('vela.tenant.service');
export const TENANT_CONTEXT_READER = new InjectionToken<TenantContextReader>('vela.tenant.reader');
class TenantScopeState implements TenantContextReader {
  #snapshot: TenantSnapshot | undefined;
  #active = true;
  #identity: (() => boolean) | undefined;
  publish(snapshot: TenantSnapshot, identity?: () => boolean): void {
    if (!this.#active || (this.#snapshot && this.#snapshot.id !== snapshot.id))
      throw new TenantError('TENANT_CONFLICT');
    this.#snapshot = snapshot;
    this.#identity = identity;
  }
  current(): TenantSnapshot | undefined {
    const value = this.#snapshot;
    return this.#active &&
      value &&
      (value.principal.expiresAtMs === undefined || value.principal.expiresAtMs > Date.now()) &&
      (!this.#identity || this.#identity())
      ? value
      : undefined;
  }
  requireTenant(): TenantSnapshot {
    const value = this.current();
    if (!value || value.authority !== 'tenant') throw new TenantError('TENANT_REQUIRED');
    return value;
  }
  requireTenantId(): string {
    return this.requireTenant().id;
  }
  requireTenantTarget(): TenantSnapshot {
    return this.requireTenant();
  }
  dispose(): void {
    this.#active = false;
    this.#snapshot = undefined;
  }
}
function scopeState(container: Container, moduleId?: string): TenantScopeState {
  const readers = container.resolveAll(TENANT_CONTEXT_READER, moduleId);
  if (readers.length !== 1 || !(readers[0] instanceof TenantScopeState))
    throw new TenantError('TENANT_CONFLICT');
  return readers[0];
}
const requirement = Reflector.createDecorator<'required' | 'optional' | 'ignored'>({
  key: 'vela.tenant.requirement',
});
export const TenantRequired = () => requirement('required');
export const TenantOptional = () => requirement('optional');
export const TenantIgnored = () => requirement('ignored');
export interface TenantModuleOptions extends TenantServiceOptions {
  selector?: TenantSelector;
  /** Non-HTTP transports supply verified credentials through their transport adapter. */
  resolve?: (
    context: ExecutionContext,
  ) => TenantRunOptions | undefined | Promise<TenantRunOptions | undefined>;
}
const OPTIONS = new InjectionToken<TenantModuleOptions>('vela.tenant.options');
const { ConfigurableModuleClass } = defineModule<TenantModuleOptions>({
  name: 'Tenant',
  optionsToken: OPTIONS,
  setup: ({ OPTIONS }) => ({
    providers: [
      defineProvider(TENANT_SERVICE, {
        inject: [OPTIONS],
        useFactory: (options) => new TenantService(options),
      }),
      defineProvider(TENANT_CONTEXT_READER, {
        scope: Scope.REQUEST,
        useFactory: () => new TenantScopeState(),
      }),
    ],
    exports: [TENANT_SERVICE, TENANT_CONTEXT_READER, OPTIONS],
  }),
});
export class TenantModule extends ConfigurableModuleClass {}
export class TenantGuard implements CanActivate {
  readonly #reflector: Reflector;
  constructor(reflector: Reflector) {
    this.#reflector = reflector;
  }
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.#reflector.getAllAndOverride(requirement, context) === 'ignored') return true;
    const container = context.getContainer();
    const owners = container?.getOwnerModuleIds(context.getClass()) ?? [];
    const moduleId = context.getModuleId() ?? (owners.length === 1 ? owners[0] : undefined);
    if (!container || !moduleId) throw new ForbiddenException('Tenant scope unavailable');
    const candidates = container.resolveAll(TENANT_SERVICE, moduleId);
    const options = container.resolveAll(OPTIONS, moduleId);
    if (candidates.length !== 1 || options.length !== 1)
      throw new ForbiddenException('Tenant configuration is ambiguous');
    const service = candidates[0]!,
      config = options[0]!;
    const requestContext =
      context.getType() === 'http' ? container.resolve(REQUEST_CONTEXT) : undefined;
    const request = requestContext?.request;
    const identity = request ? getTrustedRequestIdentity(request) : undefined;
    let input = await config.resolve?.(context);
    if (!input && request) {
      const id = (config.selector ?? headerTenant())(request) ?? identity?.tenantId;
      if (id !== undefined && !identity)
        throw new ForbiddenException('Tenant selector requires authenticated identity');
      if (id !== undefined && identity)
        input = {
          tenantId: id,
          principal: {
            ...identity.principal,
            ...(identity.expiresAtMs === undefined ? {} : { expiresAtMs: identity.expiresAtMs }),
          },
          source: 'http',
        };
    }
    if (!input) {
      if (this.#reflector.getAllAndOverride(requirement, context) === 'optional') return true;
      throw new BadRequestException('Tenant and authenticated identity are required');
    }
    if (identity?.tenantId && identity.tenantId !== input.tenantId)
      throw new ForbiddenException('Conflicting tenant identity');
    if (
      identity &&
      (identity.principal.issuer !== input.principal.issuer ||
        identity.principal.subject !== input.principal.subject ||
        identity.principal.principalType !== input.principal.principalType)
    )
      throw new ForbiddenException('Conflicting tenant principal');
    let tenant: TenantSnapshot;
    try {
      tenant = await service.admit(input);
    } catch (error) {
      if (error instanceof TenantError) throw new ForbiddenException('Tenant access denied');
      throw error;
    }
    if (request) {
      if (!identity || getTrustedRequestIdentity(request) !== identity)
        throw new ForbiddenException('Identity changed during tenant admission');
      setTrustedRequestTenant(request, identity, tenant.id);
    }
    const admittedIdentity = request ? getTrustedRequestIdentity(request) : undefined;
    scopeState(container, moduleId).publish(
      tenant,
      request ? () => getTrustedRequestIdentity(request) === admittedIdentity : undefined,
    );
    // Compatibility bridge for independently usable Hono CRUD resources.
    requestContext?.hono.set('tenantId' as never, tenant.id as never);
    return true;
  }
}
// This package is authored without decorator syntax.
Injectable()(TenantGuard);
Inject(Reflector)(TenantGuard, undefined, 0);
export const CurrentTenant = createParamDecorator((_data: undefined, context: ExecutionContext) =>
  context.getContainer()?.resolve(TENANT_CONTEXT_READER, context.getModuleId()).requireTenant(),
);

/** One queue message, scheduled tenant, or WebSocket operation gets a fresh child scope.
 * The principal must come from a trusted transport adapter; payload tenant IDs are selectors. */
export function runInTenantScope<T>(
  container: Container,
  options: TenantRunOptions,
  work: (container: Container, tenant: TenantContextReader) => T | Promise<T>,
  moduleId?: string,
): Promise<T> {
  return runInEntrypointScope(container, async (scope) => {
    const services = scope.resolveAll(TENANT_SERVICE, moduleId);
    if (services.length !== 1) throw new TenantError('TENANT_CONFLICT');
    return services[0]!.run(options, async (tenant) => {
      const state = scopeState(scope, moduleId);
      state.publish(tenant.requireTenant());
      return work(scope, state);
    });
  });
}
