/**
 * Edge-safe reimplementation of the `@velajs/cli` `introspect.ts` collectors,
 * rebuilt over the seams a provider/route-contributor can reach in vela 1.20.0
 * **public exports only** (no `@velajs/cli` import, no vela subpaths).
 *
 * Source-of-truth per collector (see the M4 report's investigation table):
 *   - routes       ← the Hono app captured in {@link StudioAppHolder}. The rich
 *                    `Controller#handler` / `source:'controller'` labeling from
 *                    `VelaApplication.describeRoutes()` is UNREACHABLE (that
 *                    lives on `RouteManager`, which the barrel keeps internal),
 *                    so every row degrades honestly to `handler:'(mounted)'`,
 *                    `source:'mounted'`.
 *   - modules      ← `Container.getModuleDescriptions()` (public) — field-for-
 *                    field parity with the CLI, no degradation.
 *   - entrypoints  ← the per-app `EntrypointRegistry` (public global token) —
 *                    same object the CLI reaches via `app.entrypoints`. Uses the
 *                    app-scoped registry only (never the process-global
 *                    `getEntrypointKinds()`), so a kind another app/test
 *                    imported can never leak in.
 */
import { EntrypointRegistry, describeToken } from '@velajs/vela';
import type { Container, ModuleDescription } from '@velajs/vela';
import type { EntrypointRow, ModuleNode, RouteRow } from '@velajs/studio-protocol';
import type { StudioAppHolder } from './app-holder';

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
      });
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
 * Every loaded module instance as the container describes it. `ModuleNode` is a
 * field-for-field structural mirror of vela's `ModuleDescription`; the explicit
 * projection keeps the wire shape pinned (a drift in either interface fails to
 * compile here) without an `as` cast.
 */
export function collectModules(container: Container): ModuleNode[] {
  return container.getModuleDescriptions().map(toModuleNode);
}

function toModuleNode(desc: ModuleDescription): ModuleNode {
  return {
    moduleId: desc.moduleId,
    imports: desc.imports,
    isGlobal: desc.isGlobal,
    lazy: desc.lazy,
    providers: desc.providers,
    exports: desc.exports,
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
      rows.push({
        kind,
        target: `${describeToken(ep.token)}${method}`,
        meta: toJsonSafe(ep.meta),
      });
    }
  }
  return rows;
}

/**
 * Project a value onto a JSON-safe clone so a pathological entrypoint `meta`
 * (a function, a class instance, a cycle) can never crash the op's response
 * serialization. Functions and cycles collapse to a string marker; everything
 * else is structurally cloned. Kept structural (not stringified) so the wire
 * `meta?: unknown` stays useful to the UI.
 */
function toJsonSafe(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' ? '[function]' : value;
  }
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => toJsonSafe(item, seen));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) out[key] = toJsonSafe(val, seen);
  return out;
}
