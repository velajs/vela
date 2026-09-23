import type { LiveRoom } from "./worker";

export const GATEWAY = "/rooms/:room/ws";

declare global {
  namespace Cloudflare {
    // worker-configuration.d.ts comes from `pnpm types`. Wrangler reads Durable
    // Object classes from the built `main` (dist/worker.js), so this binding
    // takes its class from the source entry.
    interface Env {
      LIVE_ROOM: DurableObjectNamespace<LiveRoom>;
    }
  }
}
