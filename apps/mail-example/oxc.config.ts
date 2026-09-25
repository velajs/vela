import type { UserConfig } from 'vite';

/** Share constructor injection metadata settings between native builds and tests. */
export const oxc = {
  decorator: { legacy: true, emitDecoratorMetadata: true },
} satisfies UserConfig['oxc'];
