import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
import { oxc } from './oxc.config.ts';

// Build the deployable Worker from the Wrangler source entry with DI metadata.
export default defineConfig({
  oxc,
  plugins: [cloudflare()],
});
