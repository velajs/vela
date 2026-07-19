/**
 * The routed Studio shell: entry components, nav model, and the pieces the shell
 * composes. Panels are placeholder stubs in this milestone; M6 replaces them.
 */
export { Studio, StudioApp } from './studio-app';
export type { StudioAppProps, StudioProps } from './studio-app';
export { StudioLayout } from './layout';
export type { StudioLayoutProps } from './layout';
export { CommandPalette, fuzzyMatch } from './command-palette';
export type { CommandPaletteProps } from './command-palette';
export { LoginScreen } from './login';
export type { LoginScreenProps } from './login';
export { PanelStub, lazyPanel } from './panels';
export { createStudioRouter } from './router';
export type { StudioRouterOptions } from './router';
export { ShellChromeProvider, useShellChrome } from './chrome';
export type { ShellChrome, StudioTheme } from './chrome';
export { STUDIO_TOKEN_STORAGE_KEY, readStoredToken, writeStoredToken } from './session-token';
export {
  NAV_GROUPS,
  NAV_TABS_EXHAUSTIVE,
  TAB_META,
  isTabVisible,
  tabFromPath,
  tabPath,
  visibleGroups,
} from './nav';
export type { NavGroup, NavGroupKey, StudioTab, TabMeta } from './nav';
