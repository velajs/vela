import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
import { oxc } from './oxc.config.ts';

export default defineConfig({
  oxc,
  plugins: [cloudflare()],
});
