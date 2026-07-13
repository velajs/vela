import type { DiscoveryService } from '../discovery/discovery.service';
import { contributesEntrypoints, type Entrypoint, type EntrypointKind } from './entrypoint.types';

// Kind declarations are process-global and import-time (a module declares its
// kind next to its decorator, before any app exists), so they are anchored on
// `globalThis` exactly like MetadataRegistry state: a Vite HMR re-eval must
// reuse the same store, not mint an empty one.
const KIND_STORE_KEY = Symbol.for('vela:entrypoints:v1');

function kindStore(): Map<string, EntrypointKind> {
  const g = globalThis as unknown as Record<symbol, Map<string, EntrypointKind> | undefined>;
  return (g[KIND_STORE_KEY] ??= new Map());
}

/**
 * Declare an entrypoint kind. Idempotent per `kind` (last declaration wins so
 * an HMR-re-evaluated module can re-declare); typically called at module
 * import time next to the decorator definition:
 *
 * ```ts
 * export const WS_GATEWAY_METADATA = 'vela:ws:gateway';
 * registerEntrypointKind({ kind: 'websocket', metaKey: WS_GATEWAY_METADATA, level: 'class' });
 * ```
 */
export function registerEntrypointKind(k: EntrypointKind): void {
  kindStore().set(k.kind, k);
}

/** All declared kinds (registration order). */
export function getEntrypointKinds(): EntrypointKind[] {
  return [...kindStore().values()];
}

/**
 * Reset all kind declarations. Test-only.
 * @internal
 */
export function _resetEntrypointKinds(): void {
  kindStore().clear();
}

/**
 * The per-application view of every entrypoint: built once after
 * `onApplicationBootstrap` hooks have run (so `ContributesEntrypoints`
 * providers have finished their own discovery), queried by runtime adapters:
 *
 * ```ts
 * for (const ep of app.entrypoints.ofKind('websocket')) { ... }
 * ```
 *
 * Per-app (never global): two applications in one process each build their
 * own registry from their own container.
 */
export class EntrypointRegistry {
  private readonly byKind = new Map<string, Entrypoint[]>();

  static async build(
    discovery: DiscoveryService,
    eagerInstances: readonly unknown[],
    options: { deferLazy?: boolean } = {},
  ): Promise<EntrypointRegistry> {
    const registry = new EntrypointRegistry();
    // With deferLazy, providers of unmaterialized lazy modules yield
    // metadata-only entries (instance: undefined). Dispatchers re-resolve by
    // token per event, so the owning module materializes at dispatch time.
    const filter = options.deferLazy ? { deferLazy: true } : undefined;

    for (const kind of getEntrypointKinds()) {
      if (kind.level === 'class') {
        for (const found of discovery.providersWithMeta(kind.metaKey, filter)) {
          registry.add({
            kind: kind.kind,
            token: found.token,
            instance: found.instance,
            meta: found.meta,
          });
        }
      } else {
        for (const found of discovery.methodsWithMeta(kind.metaKey, filter)) {
          registry.add({
            kind: kind.kind,
            token: found.class.token,
            instance: found.class.instance,
            methodName: found.methodName,
            meta: found.meta,
          });
        }
      }
    }

    // Computed contributions. A contributor is AUTHORITATIVE for every kind it
    // reports: its entries replace any metaKey-derived ones of the same kind,
    // so a dispatcher that both carries decorator metadata and computes richer
    // entries (path routing, aggregated handlers) never double-reports.
    const contributed: Entrypoint[] = [];
    for (const instance of new Set(eagerInstances)) {
      if (!contributesEntrypoints(instance)) continue;
      contributed.push(...(await instance.collectEntrypoints(discovery)));
    }
    for (const kind of new Set(contributed.map((ep) => ep.kind))) {
      registry.byKind.delete(kind);
    }
    for (const ep of contributed) registry.add(ep);

    return registry;
  }

  private add(ep: Entrypoint): void {
    const list = this.byKind.get(ep.kind);
    if (list) list.push(ep);
    else this.byKind.set(ep.kind, [ep]);
  }

  ofKind<M = unknown>(kind: string): Entrypoint<M>[] {
    return (this.byKind.get(kind) ?? []) as Entrypoint<M>[];
  }

  kinds(): string[] {
    return [...this.byKind.keys()];
  }

  all(): Entrypoint[] {
    return [...this.byKind.values()].flat();
  }
}
