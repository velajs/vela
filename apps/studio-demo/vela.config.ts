/**
 * `vela.config.ts` — the config-boot entry for the Vela CLI (`vela doctor --app`,
 * `vela route list`, ...). The CLI loads it, and the decorated sources it imports,
 * through Vite, and boots the demo app with this process's environment as ENV. To
 * run the app on a port instead, use `src/main.ts` (`node dist/main.js`) and
 * `vela studio --url http://localhost:8787`.
 */
import { defineVelaConfig } from '@velajs/cli/config';
import { createApp } from './src/create-app';

export default defineVelaConfig({
  createApp: () => createApp({ env: process.env }),
});
