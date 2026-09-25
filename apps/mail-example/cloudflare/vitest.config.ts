import { cloudflareTest } from '@cloudflare/vitest-plugin';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: false,
  test: { include: ['cloudflare/worker.test.ts'] },
  plugins: [
    cloudflareTest({ wrangler: { configPath: './cloudflare/wrangler.jsonc' } }),
    swc.vite({
      tsconfigFile: false,
      swcrc: false,
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        keepClassNames: true,
      },
    }),
  ],
});
