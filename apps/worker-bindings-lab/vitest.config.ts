import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vela reads constructor dependencies from legacy decorators and the
  // `design:paramtypes` metadata they record; Vitest's Oxc transform emits both
  // only when asked.
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: {
    globals: false,
    include: ['test/**/*.test.ts'],
    // The Worker entry exports a Durable Object class, whose base comes from
    // the Workers runtime; the lab runs in Node.
    alias: [
      {
        find: /^cloudflare:workers$/,
        replacement: fileURLToPath(new URL('./test/cloudflare-workers.ts', import.meta.url)),
      },
    ],
    server: { deps: { inline: [/@velajs\/cloudflare/] } },
  },
});
