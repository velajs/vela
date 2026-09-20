import { parseStudioConnection } from '@velajs/studio-protocol';
/** Standalone mount using the validated local host connection contract. */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { StudioApp } from '../shell/studio-app';
import type { StudioAppProps } from '../shell/studio-app';

declare global {
  interface Window {
    __VELA_STUDIO__?: unknown;
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
  const connection =
    appProps.connection ??
    (globals?.['__VELA_STUDIO__'] === undefined
      ? undefined
      : parseStudioConnection(globals['__VELA_STUDIO__']));

  const container = resolveElement(element);
  const root = createRoot(container);
  root.render(createElement(StudioApp, { ...appProps, connection }));

  return { root, unmount: () => root.unmount() };
}
