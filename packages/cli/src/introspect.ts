import type { VelaApplication } from '@velajs/vela';
import { describeToken, getEntrypointKinds } from '@velajs/vela';
import type { ModuleDescription, RouteDescription } from '@velajs/vela';

/** One row of `vela route list`. */
export interface RouteRow {
  method: string;
  path: string;
  /** `Controller#handler`, or `(mounted)` for routes vela did not compose
   * itself (RouteContributor/CRUD, OpenAPI UI mounts, manual Hono routes). */
  handler: string;
  source: 'controller' | 'mounted';
}

/**
 * The app's route table: `describeRoutes()` rows (framework-composed truth)
 * plus everything else present on the Hono router, deduped and labeled
 * `(mounted)`. Returns null when the app never built HTTP routes.
 */
export function collectRoutes(app: VelaApplication): RouteRow[] | null {
  let described: RouteDescription[];
  try {
    described = app.describeRoutes();
  } catch {
    return null; // no HTTP routes built (slim/non-HTTP app)
  }

  const rows: RouteRow[] = described.map((r) => ({
    method: r.method,
    path: r.path,
    handler: `${r.controller}#${r.handler}`,
    source: 'controller',
  }));

  const covered = new Set(described.map((r) => `${r.method} ${r.path}`));
  for (const r of described) {
    // @Head handlers are served by Hono under GET — claim that row too so it
    // doesn't reappear as a mounted duplicate.
    if (r.method === 'HEAD') covered.add(`GET ${r.path}`);
  }

  const seenMounted = new Set<string>();
  for (const honoRoute of app.getHonoApp().routes) {
    // 'ALL' entries are middleware mounts (framework-internal disposal/context
    // wrappers, global + scoped middleware) — not endpoints.
    if (honoRoute.method === 'ALL') continue;
    const key = `${honoRoute.method} ${honoRoute.path}`;
    if (covered.has(key) || seenMounted.has(key)) continue;
    seenMounted.add(key);
    rows.push({
      method: honoRoute.method,
      path: honoRoute.path,
      handler: '(mounted)',
      source: 'mounted',
    });
  }

  return rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** `vela module graph` tree lines (or raw descriptions for --json). */
export function collectModules(app: VelaApplication): ModuleDescription[] {
  return app.getContainer().getModuleDescriptions();
}

export function renderModuleTree(modules: ModuleDescription[]): string[] {
  const byId = new Map(modules.map((m) => [m.moduleId, m]));
  const imported = new Set(modules.flatMap((m) => m.imports));
  const roots = modules.filter((m) => !imported.has(m.moduleId));

  const lines: string[] = [];
  const render = (id: string, depth: number, trail: Set<string>): void => {
    const mod = byId.get(id);
    const flags = mod
      ? [mod.isGlobal ? 'global' : null, mod.lazy ? 'lazy' : null].filter(Boolean)
      : [];
    const suffix = flags.length > 0 ? ` (${flags.join(', ')})` : '';
    const providers = mod
      ? ` — ${mod.providers.length} provider${mod.providers.length === 1 ? '' : 's'}`
      : '';
    lines.push(`${'  '.repeat(depth)}${id}${suffix}${providers}`);
    if (!mod || trail.has(id)) return;
    const nextTrail = new Set(trail).add(id);
    for (const child of mod.imports) render(child, depth + 1, nextTrail);
  };

  for (const root of roots) render(root.moduleId, 0, new Set());
  return lines;
}

/** One row of `vela entrypoint list`. */
export interface EntrypointRow {
  kind: string;
  target: string;
  meta: string;
}

function safeMeta(meta: unknown): string {
  try {
    return (
      JSON.stringify(meta, (_key, value: unknown) =>
        typeof value === 'function'
          ? '[function]'
          : typeof value === 'object' &&
              value !== null &&
              value.constructor !== Object &&
              !Array.isArray(value)
            ? `[${(value as object).constructor.name}]`
            : value,
      ) ?? 'undefined'
    );
  } catch {
    return '[unserializable]';
  }
}

/**
 * Every DECLARED entrypoint kind (from the global kind store — includes kinds
 * with zero entries) joined with the app's entries. Metadata-only entries of
 * lazy modules list fine; nothing materializes.
 */
export function collectEntrypoints(app: VelaApplication): EntrypointRow[] {
  const rows: EntrypointRow[] = [];
  const declared = getEntrypointKinds().map((k: { kind: string }) => k.kind);
  const populated = app.entrypoints.kinds();
  const kinds = [...new Set([...declared, ...populated])];

  for (const kind of kinds) {
    const entries = app.entrypoints.ofKind(kind);
    if (entries.length === 0) {
      rows.push({ kind, target: '(no entrypoints)', meta: '' });
      continue;
    }
    for (const ep of entries) {
      const method = ep.methodName !== undefined ? `#${String(ep.methodName)}` : '';
      rows.push({ kind, target: `${describeToken(ep.token)}${method}`, meta: safeMeta(ep.meta) });
    }
  }
  return rows;
}
