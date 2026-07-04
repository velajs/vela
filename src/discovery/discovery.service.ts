import { Scope } from '../constants';
import { Container } from '../container/container';
import { Inject, Injectable } from '../container/decorators';
import type { Token, Type } from '../container/types';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor } from '../registry/types';
import type { DiscoverableDecorator } from './discoverable.decorator';

/** A container-registered class provider surfaced by discovery. */
export interface DiscoveredClass<T = unknown> {
  token: Token;
  metatype: Type<T>;
  /** Module buckets holding this token (registration order; first = primary). */
  moduleIds: string[];
  scope: Scope;
  /**
   * Resolved instance. `undefined` only when the provider is request-scoped
   * and `includeRequestScoped` was not set — request-scoped providers cannot
   * be materialized at bootstrap without fabricating a phantom request.
   */
  instance: T | undefined;
}

export interface DiscoveredMethodMeta<M = unknown> {
  class: DiscoveredClass;
  methodName: string | symbol;
  meta: M;
}

export interface DiscoveryFilter {
  /** Restrict to providers declared by these module buckets. */
  moduleId?: string | string[];
  /**
   * Resolve request-scoped providers too (constructs an instance outside any
   * request — only for callers that know what they're doing). Default false:
   * request-scoped hits are skipped with a diagnostics warning.
   */
  includeRequestScoped?: boolean;
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
 *     for (const { instance, meta } of this.discovery.providersWithMeta<MyMeta>(MY_KEY)) {
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
 * like the legacy loops: `throw` rethrows, `log` warns and skips, `silent`
 * skips — so a broken provider never silently changes discovery semantics.
 */
@Injectable()
export class DiscoveryService {
  constructor(@Inject(Container) private readonly container: Container) {}

  /** Every class-token provider registered in the container. */
  getProviders(filter?: DiscoveryFilter): DiscoveredClass[] {
    const out: DiscoveredClass[] = [];
    for (const token of this.container.getTokens()) {
      if (typeof token !== 'function') continue;
      const entry = this.buildEntry(token as Type, filter, 'provider discovery');
      if (entry) out.push(entry);
    }
    return out;
  }

  /**
   * Providers whose class carries class-level metadata under `key` — both
   * class decorators (single value) and method decorators that append
   * class-level lists (`@Cron`, `@OnEvent`, `@SubscribeMessage`).
   */
  providersWithMeta<M>(
    key: string | DiscoverableDecorator<M>,
    filter?: DiscoveryFilter,
  ): Array<DiscoveredClass & { meta: M }> {
    const metaKey = resolveKey(key as string | DiscoverableDecorator<unknown>);
    const out: Array<DiscoveredClass & { meta: M }> = [];
    for (const target of this.candidatesWithClassMeta(metaKey)) {
      const entry = this.buildEntry(target as Type, filter, `discovery of '${metaKey}'`);
      if (!entry) continue;
      const meta = MetadataRegistry.getCustomClassMeta(target, metaKey) as M;
      out.push({ ...entry, meta });
    }
    return out;
  }

  /**
   * Handler methods carrying metadata under `key`. Merges the two storage
   * conventions:
   *  - class-level appended lists whose items carry `methodName`
   *    (`@Cron`/`@OnEvent`-style method decorators), and
   *  - true handler-level metadata (`@SetMetadata`/`createDiscoverableDecorator`
   *    applied to a method).
   */
  methodsWithMeta<M>(
    key: string | DiscoverableDecorator<M>,
    filter?: DiscoveryFilter,
  ): DiscoveredMethodMeta<M>[] {
    const metaKey = resolveKey(key as string | DiscoverableDecorator<unknown>);
    const out: DiscoveredMethodMeta<M>[] = [];

    for (const target of this.candidatesWithClassMeta(metaKey)) {
      const classMeta = MetadataRegistry.getCustomClassMeta(target, metaKey);
      if (!Array.isArray(classMeta) || !classMeta.some(isMethodMetaItem)) continue;
      const entry = this.buildEntry(target as Type, filter, `discovery of '${metaKey}'`);
      if (!entry) continue;
      for (const item of classMeta) {
        if (!isMethodMetaItem(item)) continue;
        out.push({ class: entry, methodName: item.methodName, meta: item as M });
      }
    }

    for (const target of MetadataRegistry.getClassesWithHandlerMeta(metaKey)) {
      if (!this.container.has(target as Token)) continue;
      const entry = this.buildEntry(target as Type, filter, `discovery of '${metaKey}'`);
      if (!entry) continue;
      for (const { handler, value } of MetadataRegistry.getHandlersWithMeta(target, metaKey)) {
        out.push({ class: entry, methodName: handler, meta: value as M });
      }
    }

    return out;
  }

  /**
   * Index-first candidate walk with a legacy full-scan fallback: when the
   * reverse index knows nothing about a key, an older copy of the registry
   * module may have taken the writes (mixed dist/src or package versions in
   * one process) — fall back to scanning container tokens the way the
   * pre-DiscoveryService loops did.
   */
  private candidatesWithClassMeta(metaKey: string): object[] {
    const indexed = MetadataRegistry.getClassesWithClassMeta(metaKey);
    if (indexed.size > 0) {
      return [...indexed].filter((t) => this.container.has(t as Token));
    }
    const out: object[] = [];
    for (const token of this.container.getTokens()) {
      if (typeof token !== 'function') continue;
      if (MetadataRegistry.getCustomClassMeta(token, metaKey) !== undefined) {
        out.push(token);
      }
    }
    return out;
  }

  private buildEntry(
    metatype: Type,
    filter: DiscoveryFilter | undefined,
    label: string,
  ): DiscoveredClass | undefined {
    const moduleIds = this.container.getOwnerModuleIds(metatype);
    if (moduleIds.length === 0) return undefined;

    if (filter?.moduleId !== undefined) {
      const wanted = Array.isArray(filter.moduleId) ? filter.moduleId : [filter.moduleId];
      if (!moduleIds.some((id) => wanted.includes(id))) return undefined;
    }

    const scope = this.container.getProviderScope(metatype) ?? Scope.SINGLETON;

    if (scope === Scope.REQUEST && !filter?.includeRequestScoped) {
      if (this.container.getDiagnostics() === 'log') {
        console.warn(
          `[vela] ${label}: ${metatype.name} is request-scoped and cannot be ` +
            `materialized at bootstrap — skipped. Pass { includeRequestScoped: true } to override.`,
        );
      }
      return { token: metatype, metatype, moduleIds, scope, instance: undefined };
    }

    let instance: unknown;
    try {
      instance = this.container.resolve(metatype);
    } catch (err) {
      const mode = this.container.getDiagnostics();
      if (mode === 'throw') throw err;
      if (mode === 'log') {
        console.warn(`[vela] ${label}: cannot resolve ${metatype.name}:`, err);
      }
      return undefined;
    }

    return { token: metatype, metatype, moduleIds, scope, instance };
  }
}

// Re-export so consumers can narrow on Constructor without importing registry types.
export type { Constructor };
