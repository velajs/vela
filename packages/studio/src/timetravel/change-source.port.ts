/**
 * `ChangeSource` — the OPTIONAL CDC seam that upgrades the portable adapter from
 * snapshot granularity to `snapshot+cdc`. When bound, a restore addressed by a
 * point in TIME between two snapshots first loads the closest snapshot at-or-
 * before that time, then replays the committed changes in the open window
 * `(snapshotTime, requestedTime]` to land on the exact mid-point state.
 *
 * This is the ZERO-SEAM CDC path from the plan: it reads an EXISTING change log
 * (the crud audit store) rather than adding a `changeFeed` capability to crud.
 * The crud-backed impl ({@link import('../crud/index').AuditStoreChangeSource})
 * lives in the `@velajs/studio/crud` subpath — this core seam stays crud-free so
 * a BYO change log (a WAL tail, an outbox table, …) can bind the same token.
 *
 * Investigation note (M8a): `@velajs/crud`'s `AuditStore` (`@velajs/crud/audit`)
 * IS a public, readable change log (`query()` → before/after/timestamp/action),
 * but the wired instance sits behind an INTERNAL token, so it is not reachable
 * through a public accessor — the app must hand its own `AuditStore` instance to
 * `AuditStoreChangeSource`. Absent a bound change source, the adapter reports
 * `granularity: 'snapshot'` (honest) and never claims CDC it cannot serve.
 */
import { InjectionToken } from '@velajs/vela';
import type { StudioChange } from '@velajs/studio-protocol';
import type { TimeTravelScope } from '@velajs/studio-protocol';

/** A readable committed-change log keyed by table name. */
export interface ChangeSource {
  /**
   * The changes committed to `table` in the half-open window `(fromTs, toTs]`,
   * ordered oldest→newest. `table` is the crud TABLE name (matching the audit
   * log); the returned {@link StudioChange} carries the before/after images the
   * adapter replays.
   */
  changesBetween(
    table: string,
    fromTs: number,
    toTs: number,
    scope?: TimeTravelScope,
  ): Promise<StudioChange[]>;
}

/** DI token an app binds to enable audit-backed CDC replay (`snapshot+cdc`). */
export const CHANGE_SOURCE = new InjectionToken<ChangeSource>('CHANGE_SOURCE');
