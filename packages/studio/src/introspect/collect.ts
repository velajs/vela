/** Portable collectors over public per-application inspection APIs. Controller
 * attribution is supplied by studioRuntimeAdapter; contributed routes retain
 * their mounted label. Module snapshots never resolve providers. */
import { DiscoveryService, EntrypointRegistry, describeToken } from '@velajs/vela/module-kit';
import type { Container, ModuleDescription } from '@velajs/vela/module-kit';
import type { EntrypointRow, ModuleNode, RouteRow } from '@velajs/studio-protocol';
import type { StudioAppHolder } from './app-holder';
import { diagnosticSnapshot } from './snapshot';

/**
 * The app route table. Two tiers, deduped by `method path` and sorted for a
 * stable wire order:
 *
 *   1. ATTRIBUTED controller routes from `VelaApplication.describeRoutes()` —
 *      present only when the app wired {@link studioRuntimeAdapter} (its
 *      `onRoutesBuilt` deposited them in the {@link StudioAppHolder}). These
 *      carry the real `Controller#handler` and `source: 'controller'`.
 *   2. Everything left in the live Hono table (contributor-mounted surfaces the
 *      framework did NOT compose itself — the admin surface, the crud bridge)
 *      degrades honestly to `handler:'(mounted)'` / `source:'mounted'`.
 *
 * Without the adapter, tier 1 is empty and EVERY row degrades to `(mounted)` —
 * the pre-M9 behavior, unchanged. `method:'ALL'` entries are middleware mounts
 * (not endpoints) and are dropped, mirroring the CLI. Returns `[]` before mount.
 */
export function collectRoutes(holder: StudioAppHolder): RouteRow[] {
  const rows: RouteRow[] = [];
  const seen = new Set<string>();

  const described = holder.routeDescriptions;
  if (described !== null) {
    for (const route of described) {
      const key = `${route.method} ${route.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        method: route.method,
        path: route.path,
        handler: `${route.controller}#${route.handler}`,
        source: 'controller',
        moduleId: route.moduleId,
      });
    }
    // Only suppress mounted aliases, never a separately declared GET handler.
    for (const route of described) {
      if (route.method === 'HEAD') seen.add(`GET ${route.path}`);
    }
  }

  const app = holder.app;
  if (app) {
    for (const route of app.routes) {
      if (route.method === 'ALL') continue;
      const key = `${route.method} ${route.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        method: route.method,
        path: route.path,
        handler: '(mounted)',
        source: 'mounted',
      });
    }
  }

  return rows.toSorted((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/**
 * Public module metadata plus effective scopes for class-token registrations.
 * Metadata-only discovery never constructs providers or activates lazy modules.
 */
export function collectModules(container: Container): ModuleNode[] {
  const scopes = new Map<string, NonNullable<ModuleNode['providerScopes']>>();
  if (container.has(DiscoveryService)) {
    for (const entry of container
      .resolve(DiscoveryService)
      .getRegistrations({ metadataOnly: true })) {
      const rows = scopes.get(entry.moduleId) ?? [];
      rows.push({ token: describeToken(entry.token), scope: entry.scope });
      scopes.set(entry.moduleId, rows);
    }
  }
  return container
    .getModuleDescriptions()
    .map((desc) => toModuleNode(desc, scopes.get(desc.moduleId) ?? []));
}

function toModuleNode(
  desc: ModuleDescription,
  providerScopes: NonNullable<ModuleNode['providerScopes']>,
): ModuleNode {
  return {
    moduleId: desc.moduleId,
    imports: desc.imports,
    isGlobal: desc.isGlobal,
    lazy: desc.lazy,
    providers: desc.providers,
    exports: desc.exports,
    providerScopes,
  };
}

/**
 * Every entrypoint the app actually registered, one row per entry. Reads the
 * per-app {@link EntrypointRegistry} (built at the end of bootstrap and exposed
 * as a public global token) — iterating only `kinds()` that hold entries, so
 * empty declared kinds contribute nothing (no CLI-style `(no entrypoints)`
 * placeholder rows, and no cross-app leakage from the process-global kind
 * store). Returns `[]` when nothing registered entrypoints.
 */
export function collectEntrypoints(container: Container): EntrypointRow[] {
  if (!container.has(EntrypointRegistry)) return [];
  const registry = container.resolve(EntrypointRegistry);

  const rows: EntrypointRow[] = [];
  for (const kind of registry.kinds()) {
    for (const ep of registry.ofKind(kind)) {
      const method = ep.methodName !== undefined ? `#${String(ep.methodName)}` : '';
      const scope =
        ep.moduleId === undefined ? undefined : container.getProviderScope(ep.token, ep.moduleId);
      rows.push({
        kind,
        target: `${describeToken(ep.token)}${method}`,
        meta: diagnosticSnapshot(ep.meta),
        ...(ep.moduleId === undefined ? {} : { moduleId: ep.moduleId }),
        ...(scope === undefined ? {} : { scope }),
      });
    }
  }
  return rows;
}
