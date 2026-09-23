import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      /** Test-only binding: vitest.config.ts reads migrations/ for the spec to apply. */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
