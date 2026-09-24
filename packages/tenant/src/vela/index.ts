import {
  APP_GUARD,
  Inject,
  Injectable,
  InjectionToken,
  ModuleRef,
  REQUEST_CONTEXT,
  Scope,
  defineModule,
  defineProvider,
  createParamDecorator,
  Reflector,
  ForbiddenException,
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  type GuardPhase,
} from '@velajs/vela';
import {
  runInEntrypointScope,
  getTrustedRequestIdentity,
  setTrustedRequestTenant,
} from '@velajs/vela/module-kit';
import type { Container } from '@velajs/vela/module-kit';
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
  return assertScopeState(container.resolveAll(TENANT_CONTEXT_READER, moduleId));
}
function assertScopeState(readers: readonly TenantContextReader[]): TenantScopeState {
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
  /**
   * `'global'` (default) installs `TenantGuard` as a global guard in the
   * `tenant` phase: after authentication, before authorization, whatever the
   * import order. It admits a tenant on every application route, including
   * routes in modules that do not import this module; mark exceptions with
   * `@TenantOptional()` or `@TenantIgnored()`. `'none'` leaves admission to
   * `@UseGuards(TenantGuard)`. With `forRootAsync`, pass it beside the factory.
   */
  guard?: 'global' | 'none';
  selector?: TenantSelector;
  /** Non-HTTP transports supply verified credentials through their transport adapter. */
  resolve?: (
    context: ExecutionContext,
  ) => TenantRunOptions | undefined | Promise<TenantRunOptions | undefined>;
}
const OPTIONS = new InjectionToken<TenantModuleOptions>('vela.tenant.options');
const { ConfigurableModuleClass } = defineModule<TenantModuleOptions, 'guard'>({
  name: 'Tenant',
  optionsToken: OPTIONS,
  // `guard` shapes the module graph: `forRootAsync` takes it beside the factory.
  structural: ['guard'],
  defaults: { guard: 'global' },
  setup: ({ OPTIONS, options }) => ({
    providers: [
      // The installed guard answers to TenantGuard, so testing overrides reach it.
      ...(installGuard(options.guard)
        ? [
            defineProvider(TenantGuard, { useClass: InstalledTenantGuard }),
            defineProvider(APP_GUARD, { useExisting: TenantGuard }),
          ]
        : []),
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
function installGuard(guard: TenantModuleOptions['guard']): boolean {
  if (guard !== undefined && guard !== 'global' && guard !== 'none') {
    throw new TypeError("TenantModule guard must be 'global' or 'none'");
  }
  return guard !== 'none';
}
export class TenantModule extends ConfigurableModuleClass {}
// The guards TenantModule installs globally, and the module each belongs to.
const installedHosts = new WeakMap<TenantGuard, ModuleRef>();
export class TenantGuard implements CanActivate {
  /** Global guards admit tenants after authentication and before authorization. */
  static readonly phase: GuardPhase = 'tenant';
  /**
   * Integration routes marked `SkipGuardPhases(['tenant'])` admit tenants
   * themselves. A subclass declares `false` to run on them too.
   */
  static readonly skippable: boolean = true;
  readonly #reflector: Reflector;
  constructor(reflector: Reflector) {
    this.#reflector = reflector;
  }
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const declared = this.#reflector.getAllAndOverride(requirement, context);
    if (declared === 'ignored') return true;
    const container = context.getContainer();
    const owners = container?.getOwnerModuleIds(context.getClass()) ?? [];
    const moduleId = context.getModuleId() ?? (owners.length === 1 ? owners[0] : undefined);
    if (!container || !moduleId) throw new ForbiddenException('Tenant scope unavailable');
    let candidates = container.resolveAll(TENANT_SERVICE, moduleId);
    let options = container.resolveAll(OPTIONS, moduleId);
    let state = () => scopeState(container, moduleId);
    // The globally installed guard covers every application route: where the
    // route's module does not import TenantModule, it admits through its own
    // module. A route-level TenantGuard there has no configuration and denies.
    const host = installedHosts.get(this);
    if (host && candidates.length === 0 && options.length === 0) {
      candidates = [await host.resolve(TENANT_SERVICE)];
      options = [await host.resolve(OPTIONS)];
      const reader = await host.resolve(TENANT_CONTEXT_READER, context);
      state = () => assertScopeState([reader]);
    }
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
      if (declared === 'optional') return true;
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
    state().publish(
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
/** The instance `guard: 'global'` installs; it serves routes in every module. */
class InstalledTenantGuard extends TenantGuard {
  constructor(reflector: Reflector, host: ModuleRef) {
    super(reflector);
    installedHosts.set(this, host);
  }
}
Injectable()(InstalledTenantGuard);
Inject(Reflector)(InstalledTenantGuard, undefined, 0);
Inject(ModuleRef)(InstalledTenantGuard, undefined, 1);
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
