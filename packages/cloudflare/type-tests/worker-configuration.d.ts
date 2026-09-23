// A synthetic `wrangler types --include-runtime=false` output: the bindings,
// variables and secrets an application's wrangler config declares.
declare namespace Cloudflare {
  interface Env {
    CACHE: KVNamespace;
    DB: D1Database;
    FILES: R2Bucket;
    JOBS: Queue<{ taskId: string }>;
    SECRET: string;
    MODE: 'production' | 'staging';
  }
}
