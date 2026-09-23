// The environment `wrangler types --include-runtime=false` declares for
// wrangler.test.toml, kept by hand for the workerd suites. @velajs/cloudflare
// extends VelaEnv with Cloudflare.Env, so ENV carries these bindings typed.
declare namespace Cloudflare {
  interface Env {
    ENV_PROBE: 'workerd-env';
    URL_SIGNING_SECRET: 'workerd-signing-secret';
    TEST_ROOM: DurableObjectNamespace<import('./entry').TestRoom>;
    COUNTING_ROOM: DurableObjectNamespace<import('./entry').CountingRoom>;
    CACHE: KVNamespace;
    DB: D1Database;
    FILES: R2Bucket;
    QUEUE_BRIDGE: Queue;
  }
}
