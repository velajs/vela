/**
 * Minimal ambient types for `react-dom/client`. `@types/react-dom` is not in the
 * pre-provisioned dep tree (react-dom ships no `client.d.ts`), and this package
 * uses only `createRoot` from the standalone mount entry — so we declare exactly
 * that surface locally rather than pulling a new dependency.
 */
declare module 'react-dom/client' {
  import type { ReactNode } from 'react';

  export interface Root {
    render(children: ReactNode): void;
    unmount(): void;
  }

  export function createRoot(container: Element | DocumentFragment, options?: unknown): Root;
  export function hydrateRoot(
    container: Element | Document,
    children: ReactNode,
    options?: unknown,
  ): Root;
}
