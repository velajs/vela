import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
import { oxc } from './oxc.config.ts';

export default defineConfig(({ command }) => ({
  oxc,
  plugins: [
    cloudflare({
      remoteBindings: false,
      // AI and VPC have no local service emulator. Omit remote-only bindings in
      // local dev; their authenticated routes fail closed. Production build keeps them.
      config(config) {
        if (command === 'serve') {
          delete config.ai;
          delete config.browser;
          config.vpc_services = [];
        }
      },
    }),
  ],
}));
