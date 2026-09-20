/**
 * `vela.config.ts` — the config-boot entry for `vela studio`.
 *
 * Exports `createApp()` (named + default) so the Vela CLI can boot the demo app
 * and open Studio against it. To run the app standalone on a port instead, use
 * `src/main.ts` (`node dist/main.js`) and `vela studio --url http://localhost:8787`.
 */
export { createApp } from './src/create-app';
export { createApp as default } from './src/create-app';
