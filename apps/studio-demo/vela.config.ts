/**
 * `vela.config.ts` — the config-boot entry for `vela studio`.
 *
 * Exports `createApp()` (named + default) so the Vela CLI can boot the demo app
 * and open Studio against it, with this process's environment as ENV. To run the
 * app standalone on a port instead, use `src/main.ts` (`node dist/main.js`) and
 * `vela studio --url http://localhost:8787`.
 */
import { createApp as createDemoApp } from './src/create-app';

export const createApp = () => createDemoApp({ env: process.env });
export default createApp;
