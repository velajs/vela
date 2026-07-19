/**
 * `@velajs/studio-ui/standalone` — the full-page mount entry. `mountStudio`
 * creates a React root and renders {@link StudioApp}, merging the
 * `window.__VELA_BASE_PATH__` / `window.__VELA_ADMIN_TOKEN__` globals when the
 * corresponding options are omitted.
 */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { StudioApp } from '../shell/studio-app';
import type { StudioAppProps } from '../shell/studio-app';

declare global {
  interface Window {
    __VELA_BASE_PATH__?: string;
    __VELA_ADMIN_TOKEN__?: string;
  }
}

export interface MountStudioOptions extends StudioAppProps {
  /** Element (or selector) to mount into; a `<div>` is appended to `<body>` otherwise. */
  element?: HTMLElement | string;
}

export interface StudioHandle {
  root: Root;
  unmount: () => void;
}

function resolveElement(element: MountStudioOptions['element']): HTMLElement {
  if (element instanceof HTMLElement) return element;
  if (typeof element === 'string') {
    const found = document.querySelector(element);
    if (found instanceof HTMLElement) return found;
    throw new Error(`mountStudio: no element matches selector "${element}".`);
  }
  const created = document.createElement('div');
  created.className = 'vela-studio-root';
  document.body.append(created);
  return created;
}

export function mountStudio(options: MountStudioOptions = {}): StudioHandle {
  const { element, ...appProps } = options;
  const globals = typeof window === 'undefined' ? undefined : window;
  const basePath = appProps.basePath ?? globals?.['__VELA_BASE_PATH__'];
  const adminToken = appProps.adminToken ?? globals?.['__VELA_ADMIN_TOKEN__'];

  const container = resolveElement(element);
  const root = createRoot(container);
  root.render(createElement(StudioApp, { ...appProps, basePath, adminToken }));

  return { root, unmount: () => root.unmount() };
}
