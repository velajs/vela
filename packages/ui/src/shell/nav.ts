/**
 * The Studio nav model: domain groups -> tabs, each tab bound to a route path
 * and a `StudioFeatureKey`. The `satisfies` guards enforce, at compile time,
 * that every tab has a feature (via {@link TAB_META}) and that the flattened
 * group tabs equal the {@link StudioTab} union (via {@link NAV_TABS_EXHAUSTIVE}).
 */
import type { StudioCapabilities, StudioFeatureKey } from '@velajs/studio-protocol';

/** Every navigable tab. */
export type StudioTab =
  | 'home'
  | 'routes'
  | 'modules'
  | 'entrypoints'
  | 'api'
  | 'data'
  | 'timeTravel'
  | 'transfer'
  | 'users'
  | 'sessions'
  | 'organizations'
  | 'queues'
  | 'schedule'
  | 'flags'
  | 'logs'
  | 'live'
  | 'presence'
  | 'audit';

export type NavGroupKey =
  | 'overview'
  | 'application'
  | 'data'
  | 'auth'
  | 'operations'
  | 'observability';

export interface TabMeta {
  readonly feature: StudioFeatureKey;
  readonly label: string;
}

/** Per-tab feature key + label. `satisfies Record<StudioTab, TabMeta>` forces total coverage. */
export const TAB_META = {
  home: { feature: 'app', label: 'Overview' },
  routes: { feature: 'app', label: 'Routes' },
  modules: { feature: 'app', label: 'Modules' },
  entrypoints: { feature: 'app', label: 'Entrypoints' },
  api: { feature: 'openapi', label: 'API Explorer' },
  data: { feature: 'data', label: 'Data' },
  timeTravel: { feature: 'timeTravel', label: 'Time Travel' },
  transfer: { feature: 'transfer', label: 'Transfer' },
  users: { feature: 'auth', label: 'Users' },
  sessions: { feature: 'auth', label: 'Sessions' },
  organizations: { feature: 'authOrganizations', label: 'Organizations' },
  queues: { feature: 'queue', label: 'Queues' },
  schedule: { feature: 'schedule', label: 'Schedule' },
  flags: { feature: 'flags', label: 'Flags' },
  logs: { feature: 'logs', label: 'Logs' },
  live: { feature: 'live', label: 'Live' },
  presence: { feature: 'presence', label: 'Presence' },
  audit: { feature: 'audit', label: 'Audit' },
} as const satisfies Record<StudioTab, TabMeta>;

export interface NavGroup {
  readonly key: NavGroupKey;
  readonly label: string;
  readonly tabs: readonly StudioTab[];
}

/** Sidebar structure: ordered groups, each an ordered tab list. */
export const NAV_GROUPS = [
  { key: 'overview', label: 'Overview', tabs: ['home'] },
  { key: 'application', label: 'Application', tabs: ['routes', 'modules', 'entrypoints', 'api'] },
  { key: 'data', label: 'Data', tabs: ['data', 'timeTravel', 'transfer'] },
  { key: 'auth', label: 'Auth', tabs: ['users', 'sessions', 'organizations'] },
  { key: 'operations', label: 'Operations', tabs: ['queues', 'schedule', 'flags'] },
  { key: 'observability', label: 'Observability', tabs: ['logs', 'live', 'presence', 'audit'] },
] as const satisfies readonly NavGroup[];

type GroupedTab = (typeof NAV_GROUPS)[number]['tabs'][number];
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/**
 * Compile-time exhaustiveness: the flattened group tabs must equal the
 * `StudioTab` union in both directions. If a tab is added to the type but not
 * grouped (or vice-versa), this stops being assignable to `true`. Exported so it
 * counts as used.
 */
export const NAV_TABS_EXHAUSTIVE: MutuallyAssignable<StudioTab, GroupedTab> = true;

const TAB_IDS = new Set<string>(Object.keys(TAB_META));

/** The route path for a tab (`home` -> `/`, otherwise `/{tab}`). */
export function tabPath(tab: StudioTab): string {
  return tab === 'home' ? '/' : `/${tab}`;
}

/** Resolve the active tab from a pathname; unknown paths fall back to `home`. */
export function tabFromPath(pathname: string): StudioTab {
  const slug = pathname.replace(/^\/+/, '').split('/')[0] ?? '';
  if (slug === '') return 'home';
  return TAB_IDS.has(slug) ? (slug as StudioTab) : 'home';
}

/** A tab is visible unless its feature is positively `false` (defaults-shown). */
export function isTabVisible(tab: StudioTab, features: StudioCapabilities['features']): boolean {
  return features[TAB_META[tab].feature] !== false;
}

/** The nav groups filtered to visible tabs; empty groups are dropped. */
export function visibleGroups(features: StudioCapabilities['features']): NavGroup[] {
  const result: NavGroup[] = [];
  for (const group of NAV_GROUPS) {
    const tabs = group.tabs.filter((tab) => isTabVisible(tab, features));
    if (tabs.length > 0) result.push({ key: group.key, label: group.label, tabs });
  }
  return result;
}
