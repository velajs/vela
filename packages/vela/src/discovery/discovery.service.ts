import { Scope } from '../constants';
import { Container } from '../container/container';
import { Inject, Injectable } from '../container/decorators';
import type { Token, Type } from '../container/types';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor } from '../registry/types';
import type { DiscoverableDecorator } from './discoverable.decorator';

/** A container-registered class provider surfaced by discovery. */
export interface DiscoveredRegistration<T = unknown> {
  readonly moduleId: string;
  token: Token;
  metatype: Type<T>;
  /** Module buckets holding this token (registration order; first = primary). */
  moduleIds: string[];
  scope: Scope;
  /**
   * Resolved instance, or `undefined` when metadataOnly/deferLazy applies or
   * a request-scoped provider is skipped. Request-scoped instances require
   * an invocation container (`requestScope`); discovery does not fabricate one.
   */
  instance: T | undefined;
}

export interface DiscoveredRegisteredMethodMeta<M = unknown> {
  class: DiscoveredRegistration;
  methodName: string | symbol;
  meta: M;
}

export interface DiscoveryFilter {
  /** Return metadata and ownership without constructing any provider. */
  metadataOnly?: boolean;
  /** Restrict to providers declared by these module buckets. */
  moduleId?: string | string[];
  /**
   * Execution-scope container (the `runInEntrypointScope` callback argument,
   * `getRequestContainer(c)` or `context.getContainer()`) in which
   * request-scoped providers are resolved; their instances belong to that
   * invocation. Without it, request-scoped hits are skipped with a
   * diagnostics warning.
   */
  requestScope?: Container;
  /**
   * Return providers of not-yet-materialized lazy modules as metadata-only
   * entries (`instance: undefined`, mirroring the request-scoped convention)
   * instead of resolving them — which would force the whole module group.
   * Used by `EntrypointRegistry.build`; default false so every existing
   * scanner keeps its transparent cascade-materialization semantics.
   */
  deferLazy?: boolean;
  /**
   * Return request-scoped providers as metadata-only entries (`instance:
   * undefined`) without the diagnostics warning a skipped request-scoped hit
   * otherwise produces. For callers that resolve each entry by token inside
   * its own invocation scope, such as `EntrypointRegistry.build`: nothing is
   * skipped, the instance is built per invocation.
   */
  deferRequestScoped?: boolean;
}

/** Class-level appended-list convention: method decorators that push `{ methodName, ... }` items. */
interface MethodMetaItem {
  methodName: string | symbol;
}

function isMethodMetaItem(x: unknown): x is MethodMetaItem {
  return (
    typeof x === 'object' &&
    x !== null &&
    (typeof (x as MethodMetaItem).methodName === 'string' ||
      typeof (x as MethodMetaItem).methodName === 'symbol')
  );
}

function resolveKey(key: string | DiscoverableDecorator<unknown>): string {
  return typeof key === 'string' ? key : key.KEY;
}

/**
 * Decorator-driven provider discovery — the public replacement for the
 * bootstrap scan every subsystem used to hand-roll (`container.getTokens()` +
 * `MetadataRegistry.getCustomClassMeta` + `resolve` + diagnostics handling).
 *
 * Registered globally by `bootstrap()`, so any provider can inject it:
 *
 * ```ts
 * @Injectable()
 * class MyRegistry implements OnApplicationBootstrap {
 *   constructor(private readonly discovery: DiscoveryService) {}
 *   onApplicationBootstrap() {
 *     for (const { instance, meta } of this.discovery.registrationsWithMeta<MyMeta>(MY_KEY)) {
 *       this.register(instance, meta);
 *     }
 *   }
 * }
 * ```
 *
 * Discovery is kernel-level, not encapsulation-scoped: module visibility
 * protects modules from *each other*, never from the framework's own
 * dispatchers. Use `DiscoveryFilter.moduleId` for the rare narrowing case.
 *
 * The resolve-failure policy honors the container's diagnostics mode exactly
 * `throw` rethrows, `log` warns and skips, `silent`
 * skips — so a broken provider never silently changes discovery semantics.
 */
@Injectable()
export class DiscoveryService {
  readonly #container: Container;

  constructor(@Inject(Container) container: Container) {
    this.#container = container;
  }

  /** Every owning registration of each class token, in registration order. */
  getRegistrations(filter?: DiscoveryFilter): DiscoveredRegistration[] {
    const out: DiscoveredRegistration[] = [];
    for (const token of this.#container.getTokens()) {
      if (typeof token !== 'function') continue;
      out.push(...this.buildEntries(token, filter, 'registration discovery'));
    }
    return out;
  }

  registrationsWithMeta<M>(
    key: string | DiscoverableDecorator<M>,
    filter?: DiscoveryFilter,
  ): Array<DiscoveredRegistration & { meta: M }> {
    const metaKey = resolveKey(key as string | DiscoverableDecorator<unknown>);
    const out: Array<DiscoveredRegistration & { meta: M }> = [];
    for (const target of this.candidatesWithClassMeta(metaKey)) {
      const meta = MetadataRegistry.getCustomClassMeta(target, metaKey) as M;
      for (const entry of this.buildEntries(target as Type, filter, `discovery of '${metaKey}'`)) {
        out.push({ ...entry, meta });
      }
    }
    return out;
  }

  registeredMethodsWithMeta<M>(
    key: string | DiscoverableDecorator<M>,
    filter?: DiscoveryFilter,
  ): DiscoveredRegisteredMethodMeta<M>[] {
    return this.findMethods(key, (target, label) => this.buildEntries(target, filter, label));
  }

  private findMethods<M, T extends DiscoveredRegistration>(
    key: string | DiscoverableDecorator<M>,
    entries: (target: Type, label: string) => T[],
  ): Array<{ class: T; methodName: string | symbol; meta: M }> {
    const metaKey = resolveKey(key as string | DiscoverableDecorator<unknown>);
    const out: Array<{ class: T; methodName: string | symbol; meta: M }> = [];
    const label = `discovery of '${metaKey}'`;
    for (const target of this.candidatesWithClassMeta(metaKey)) {
      const classMeta = MetadataRegistry.getCustomClassMeta(target, metaKey);
      if (!Array.isArray(classMeta) || !classMeta.some(isMethodMetaItem)) continue;
      for (const entry of entries(target as Type, label)) {
        for (const item of classMeta) {
          if (isMethodMetaItem(item))
            out.push({ class: entry, methodName: item.methodName, meta: item as M });
        }
      }
    }
    for (const target of MetadataRegistry.getClassesWithHandlerMeta(metaKey)) {
      if (!this.#container.has(target as Token)) continue;
      for (const entry of entries(target as Type, label)) {
        for (const { handler, value } of MetadataRegistry.getHandlersWithMeta(target, metaKey)) {
          out.push({ class: entry, methodName: handler, meta: value as M });
        }
      }
    }
    return out;
  }

  /** Read the current registry's metadata index, restricted to this application. */
  private candidatesWithClassMeta(metaKey: string): object[] {
    return [...MetadataRegistry.getClassesWithClassMeta(metaKey)].filter((target) =>
      this.#container.has(target as Token),
    );
  }

  private matchingOwners(moduleIds: string[], filter?: DiscoveryFilter): string[] {
    if (filter?.moduleId === undefined) return moduleIds;
    const wanted = Array.isArray(filter.moduleId) ? filter.moduleId : [filter.moduleId];
    return moduleIds.filter((id) => wanted.includes(id));
  }

  private buildEntries(
    metatype: Type,
    filter: DiscoveryFilter | undefined,
    label: string,
  ): DiscoveredRegistration[] {
    const moduleIds = this.#container.getOwnerModuleIds(metatype);
    const out: DiscoveredRegistration[] = [];
    for (const moduleId of this.matchingOwners(moduleIds, filter)) {
      const entry = this.buildRegistration(metatype, moduleId, moduleIds, filter, label);
      if (entry) out.push(entry);
    }
    return out;
  }

  private buildRegistration(
    metatype: Type,
    moduleId: string,
    moduleIds: string[],
    filter: DiscoveryFilter | undefined,
    label: string,
  ): DiscoveredRegistration | undefined {
    const scope = this.#container.getProviderScope(metatype, moduleId) ?? Scope.DEFAULT;
    const metadata = { token: metatype, metatype, moduleId, moduleIds, scope };
    if (
      filter?.metadataOnly ||
      (filter?.deferLazy && this.#container.isLazyPending(metatype, moduleId)) ||
      (filter?.deferRequestScoped && scope === Scope.REQUEST)
    ) {
      return { ...metadata, instance: undefined };
    }
    if (filter?.requestScope && !filter.requestScope.sharesRootWith(this.#container)) {
      throw new Error('DiscoveryFilter.requestScope belongs to another application.');
    }
    const container = scope === Scope.REQUEST ? filter?.requestScope : this.#container;
    if (!container) {
      if (this.#container.getDiagnostics() === 'log') {
        console.warn(
          `[vela] ${label}: ${metatype.name} is request-scoped and cannot be materialized outside an invocation — skipped. Pass { requestScope } to resolve it in an execution scope.`,
        );
      }
      return { ...metadata, instance: undefined };
    }
    try {
      return { ...metadata, instance: container.resolve(metatype, moduleId) };
    } catch (err) {
      const mode = this.#container.getDiagnostics();
      if (mode === 'throw') throw err;
      if (mode === 'log')
        console.warn(`[vela] ${label}: cannot resolve ${metatype.name} in '${moduleId}':`, err);
      return undefined;
    }
  }
}

// Re-export so consumers can narrow on Constructor without importing registry types.
export type { Constructor };
