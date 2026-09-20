/**
 * Shell chrome context: carries the values the routed {@link StudioLayout} needs
 * but the router can't pass as props (theme + sign-out handler), since the layout
 * is instantiated by the route tree, not by JSX.
 */
import { createContext, useContext } from 'react';

export type StudioTheme = 'light' | 'dark';

export interface ShellChrome {
  theme: StudioTheme;
  onSignOut?: () => void;
}

const ShellChromeContext = createContext<ShellChrome>({ theme: 'dark' });

export const ShellChromeProvider = ShellChromeContext.Provider;

export function useShellChrome(): ShellChrome {
  return useContext(ShellChromeContext);
}
