/**
 * Live-query invalidation after a restore. Once a restore truncates + reloads a
 * table, any live `data.*` subscription is watching a timeline that just forked,
 * so we fire the live layer's tag invalidation with `crud:<table>` tags — the
 * exact convention `@velajs/crud` uses (`crudLiveTag(tableName)`), so existing
 * crud-backed live queries re-snapshot correctly.
 *
 * The invalidation seam is `@velajs/vela/live`'s `LiveInvalidation` class
 * (`invalidate({ tags })` → `Promise<CommitStamp | undefined>`; the DI token IS
 * the class). The core `@velajs/vela` barrel does NOT re-export it, and this
 * package's openness rule forbids static `@velajs/vela/*` subpath imports — so
 * the class is loaded LAZILY via a runtime `import()` (barrel-compliant: no
 * static `from`) and resolved from the container. When the live module is absent
 * (dynamic import fails, or the token is unbound) invalidation NO-OPS gracefully:
 * a restore must never fail because live queries aren't wired.
 */
import type { Container } from '@velajs/vela';

/**
 * The invalidation port the adapter depends on (so tests can assert with a fake).
 * `tables` are crud TABLE names; the impl maps each to a `crud:<table>` tag.
 */
export interface LiveInvalidatorPort {
  invalidateTables(tables: readonly string[]): Promise<void>;
}

/** A no-op invalidator (the default when no container/live layer is available). */
export class NoopLiveInvalidator implements LiveInvalidatorPort {
  async invalidateTables(): Promise<void> {
    // intentionally empty
  }
}

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- preserve the optional runtime subpath boundary
type LiveToken = typeof import('@velajs/vela/live').LiveInvalidation;
let liveTokenPromise: Promise<LiveToken | null> | undefined;

/**
 * Lazily resolve the `LiveInvalidation` class token from `@velajs/vela/live` via
 * a runtime `import()`. Cached across calls; resolves to `null` when the subpath
 * cannot be loaded (live layer not installed).
 */
function loadLiveToken(): Promise<LiveToken | null> {
  return (liveTokenPromise ??= import('@velajs/vela/live')
    .then((mod) => mod.LiveInvalidation)
    .catch(() => null));
}

/**
 * Resolves `@velajs/vela/live`'s `LiveInvalidation` from the app container and
 * fires `crud:<table>` tag invalidation. Every failure path (no live subpath, no
 * bound token, a throwing `invalidate`) is swallowed — best-effort by contract.
 */
export class ContainerLiveInvalidator implements LiveInvalidatorPort {
  constructor(private readonly container: Container) {}

  async invalidateTables(tables: readonly string[]): Promise<void> {
    if (tables.length === 0) return;
    try {
      const token = await loadLiveToken();
      if (token === null || !this.container.has(token)) return;
      const live = this.container.resolve(token);
      await live.invalidate({ tags: tables.map((t) => `crud:${t}`) });
    } catch {
      // best-effort: live invalidation must never break a restore
    }
  }
}
