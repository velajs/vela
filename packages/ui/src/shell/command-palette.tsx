/**
 * The ⌘K command palette: an in-house overlay with a subsequence fuzzy filter
 * over the visible tab list (no new dependency). Controlled by the layout, which
 * owns the open state and the ⌘K/Ctrl-K key handler.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { TAB_META, tabPath } from './nav';
import type { StudioTab } from './nav';

/** Case-insensitive subsequence match (`rte` matches `Routes`). */
export function fuzzyMatch(query: string, text: string): boolean {
  const needle = query.toLowerCase().replace(/\s+/g, '');
  if (needle === '') return true;
  const haystack = text.toLowerCase();
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return false;
}

export interface CommandPaletteProps {
  tabs: readonly StudioTab[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ tabs, open, onOpenChange }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      inputRef.current?.focus();
    }
  }, [open]);

  const results = useMemo(
    () => tabs.filter((tab) => fuzzyMatch(query, TAB_META[tab].label) || fuzzyMatch(query, tab)),
    [tabs, query],
  );

  if (!open) return null;

  const go = (tab: StudioTab): void => {
    onOpenChange(false);
    void navigate({ to: tabPath(tab) });
  };

  return (
    <div
      className="vela-palette"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={() => onOpenChange(false)}
    >
      <div className="vela-palette__box" onClick={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          className="vela-palette__input"
          type="text"
          placeholder="Jump to…"
          aria-label="Command palette search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && results.length > 0) go(results[0]);
            else if (event.key === 'Escape') onOpenChange(false);
          }}
        />
        <ul className="vela-palette__list" role="listbox" aria-label="Results">
          {results.length === 0 ? (
            <li className="vela-palette__empty">No matches</li>
          ) : (
            results.map((tab) => (
              <li key={tab}>
                <button type="button" className="vela-palette__item" onClick={() => go(tab)}>
                  <span className="vela-palette__label">{TAB_META[tab].label}</span>
                  <span className="vela-palette__hint">{tab}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
