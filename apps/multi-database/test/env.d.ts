import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      /** Test-only bindings: vitest.config.ts reads each database's migrations. */
      PRIMARY_MIGRATIONS: D1Migration[];
      ANALYTICS_MIGRATIONS: D1Migration[];
    }
  }
}
