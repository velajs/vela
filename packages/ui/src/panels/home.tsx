/**
 * The overview panel: a features on/off grid, a reachability probe (derived from
 * the capabilities query), the open write gates, and quick links to every
 * enabled domain.
 */
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useStudioCapabilities } from '../data/capabilities';
import { NAV_GROUPS, TAB_META, isTabVisible, tabPath } from '../shell/nav';
import { Panel, Badge } from './shared';

export default function HomePanel(): ReactNode {
  const { capabilities, isLoading, error } = useStudioCapabilities();
  const features = capabilities.features;
  const writes = capabilities.writes;
  const reachable = error === null && !isLoading;

  const featureEntries = Object.entries(features);
  const openGates = Object.entries(writes).filter(([, open]) => open);

  return (
    <Panel title="Overview" description="A live snapshot of what this deployment exposes.">
      <div className="vela-home">
        <section className="vela-card">
          <h2 className="vela-card__title">Connection</h2>
          <p className="vela-home__status">
            {error !== null ? (
              <Badge tone="danger">unreachable</Badge>
            ) : isLoading ? (
              <Badge tone="muted">probing…</Badge>
            ) : (
              <Badge tone="success">reachable</Badge>
            )}
          </p>
          {reachable ? (
            <p className="vela-state__hint">
              Capabilities negotiated. Time travel:{' '}
              {capabilities.timeTravel !== null ? 'bound' : 'unbound'}.
            </p>
          ) : null}
        </section>

        <section className="vela-card">
          <h2 className="vela-card__title">Features</h2>
          <div className="vela-home__grid">
            {featureEntries.map(([key, on]) => (
              <div className="vela-home__feature" key={key} data-on={on ? 'true' : 'false'}>
                <span className="vela-home__feature-name">{key}</span>
                <Badge tone={on ? 'success' : 'muted'}>{on ? 'on' : 'off'}</Badge>
              </div>
            ))}
          </div>
        </section>

        <section className="vela-card">
          <h2 className="vela-card__title">Write gates</h2>
          {openGates.length === 0 ? (
            <p className="vela-state__hint">Read-only — every write gate is closed.</p>
          ) : (
            <div className="vela-home__gates">
              {openGates.map(([key]) => (
                <Badge key={key} tone="warn">
                  {key}
                </Badge>
              ))}
            </div>
          )}
        </section>

        <section className="vela-card">
          <h2 className="vela-card__title">Quick links</h2>
          <nav className="vela-home__links" aria-label="Enabled domains">
            {NAV_GROUPS.map((group) => {
              const tabs = group.tabs.filter((tab) => isTabVisible(tab, features));
              if (tabs.length === 0) return null;
              return (
                <div className="vela-home__link-group" key={group.key}>
                  <span className="vela-home__link-label">{group.label}</span>
                  {tabs.map((tab) => (
                    <Link key={tab} to={tabPath(tab)} className="vela-home__link">
                      {TAB_META[tab].label}
                    </Link>
                  ))}
                </div>
              );
            })}
          </nav>
        </section>
      </div>
    </Panel>
  );
}
