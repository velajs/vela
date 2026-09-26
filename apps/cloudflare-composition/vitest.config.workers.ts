import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { oxc } from './oxc.config.ts';

export default defineConfig({
  oxc,
  test: { include: ['test/native.workers.ts'] },
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      // Configure only emulated bindings; Wrangler's AI/VPC declarations are remote-only.
      main: './src/worker.ts',
      miniflare: {
        compatibilityDate: '2026-09-25',
        compatibilityFlags: ['nodejs_compat'],
        r2Buckets: ['MEDIA'],
        images: { binding: 'IMAGES' },
        bindings: {
          DEMO_TOKEN: 'alpha-token',
          DEMO_OWNER: 'alpha',
          AI_GATEWAY_ID: 'composition-synthetic',
        },
        serviceBindings: {
          PRIVATE_API: async () => Response.json({ id: 'sample', available: 3 }),
        },
      },
    }),
  ],
});
