import type { UserConfig } from 'vite';

/**
 * Vela injects constructor dependencies from legacy decorators and the
 * `design:paramtypes` metadata they record. Vite and Vitest compile TypeScript
 * with Oxc, which emits both only when asked. vite.config.ts and
 * vitest.config.ts share this setting, stated here rather than read from
 * tsconfig.json, so every file they compile gets the same output.
 */
export const oxc = {
  decorator: { legacy: true, emitDecoratorMetadata: true },
} satisfies UserConfig['oxc'];
