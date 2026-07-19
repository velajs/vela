/**
 * The persistent shell rendered by the router's root route: a capability-gated
 * grouped sidebar, a header with the ⌘K affordance, the routed content, and the
 * command palette. Owns the palette open state + the ⌘K key handler, and bounces
 * off any tab that has become hidden.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useStudioCapabilities } from '../data/capabilities';
import { useShellChrome } from './chrome';
import { CommandPalette } from './command-palette';
import { isTabVisible, tabFromPath, tabPath, TAB_META, visibleGroups } from './nav';

export interface StudioLayoutProps {
  children: ReactNode;
}

export function StudioLayout({ children }: StudioLayoutProps) {
  const { theme, onSignOut } = useShellChrome();
  const { capabilities } = useStudioCapabilities();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const current = tabFromPath(pathname);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const groups = visibleGroups(capabilities.features);
  const visibleTabs = groups.flatMap((group) => group.tabs);

  // ⌘K / Ctrl-K toggles the palette; Escape closes it.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (event.key === 'Escape') {
        setPaletteOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Landing on (or deep-linking to) a now-hidden tab bounces to home.
  useEffect(() => {
    if (!isTabVisible(current, capabilities.features)) {
      void navigate({ to: '/', replace: true });
    }
  }, [current, capabilities.features, navigate]);

  return (
    <div className="vela-studio vela-shell" data-theme={theme}>
      <aside className="vela-sidebar">
        <div className="vela-brand">Vela Studio</div>
        <nav className="vela-nav" aria-label="Studio sections">
          {groups.map((group) => (
            <div className="vela-group" key={group.key}>
              <div className="vela-group__label">{group.label}</div>
              <ul className="vela-group__tabs">
                {group.tabs.map((tab) => (
                  <li key={tab}>
                    <Link
                      to={tabPath(tab)}
                      className="vela-tab"
                      data-active={current === tab ? 'true' : undefined}
                      activeProps={{ className: 'vela-tab vela-tab--active' }}
                    >
                      {TAB_META[tab].label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
      <div className="vela-main">
        <header className="vela-header">
          <button
            type="button"
            className="vela-cmdk"
            onClick={() => setPaletteOpen(true)}
            aria-label="Open command palette"
          >
            <span>Search</span>
            <kbd className="vela-cmdk__kbd">⌘K</kbd>
          </button>
          {onSignOut !== undefined ? (
            <button type="button" className="vela-signout" onClick={onSignOut}>
              Sign out
            </button>
          ) : null}
        </header>
        <main className="vela-content">{children}</main>
      </div>
      <CommandPalette tabs={visibleTabs} open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
