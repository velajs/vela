import type { UserConfig } from 'vite';

// Build and native tests must emit the same metadata for Vela constructor injection.
export const oxc = {
  decorator: { legacy: true, emitDecoratorMetadata: true },
} satisfies UserConfig['oxc'];
