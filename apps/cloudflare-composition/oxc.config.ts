import type { UserConfig } from 'vite';

export const oxc = {
  decorator: { legacy: true, emitDecoratorMetadata: true },
} satisfies UserConfig['oxc'];
