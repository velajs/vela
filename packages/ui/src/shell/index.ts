/**
 * The routed Studio shell — public surface only. Consumers embed {@link Studio}
 * or {@link StudioApp} (or the `@velajs/studio-ui/standalone` `mountStudio`
 * entry) and read the nav/tab/theme types when they need them. Everything else
 * (layout, router builder, command palette, login screen, panel stubs, chrome
 * context, session-token storage, and the nav model helpers) is a shell internal
 * and is intentionally not re-exported here.
 */
export { Studio, StudioApp } from './studio-app';
export type { StudioAppProps, StudioProps } from './studio-app';
export type { StudioTheme } from './chrome';
export type { NavGroup, NavGroupKey, StudioTab, TabMeta } from './nav';
