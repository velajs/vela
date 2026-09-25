// The environment `wrangler types --include-runtime=false` declares for
// wrangler.test.toml, kept by hand for the workerd suites. @velajs/cloudflare
// extends VelaEnv with Cloudflare.Env, so ENV carries these bindings typed.
declare namespace Cloudflare {
  interface Env {
    ENV_PROBE: 'workerd-env';
    URL_SIGNING_SECRET: 'workerd-signing-secret';
    WS_ALLOWED_ORIGIN: 'https://app.test';
    WS_TENANT: 'tenant-1';
    TEST_ROOM: DurableObjectNamespace<import('./entry').TestRoom>;
    COUNTING_ROOM: DurableObjectNamespace<import('./entry').CountingRoom>;
    CRON_ROOM: DurableObjectNamespace<import('./entry').CronRoom>;
    SQLITE_LIVE_ROOM: DurableObjectNamespace<import('./entry').SqliteLiveRoom>;
    KV_LIVE_ROOM: DurableObjectNamespace<import('./entry').KvLiveRoom>;
    COUNTER: DurableObjectNamespace<import('./entry').Counter>;
    BROKEN_COUNTER: DurableObjectNamespace<import('./entry').BrokenCounter>;
    CACHE: KVNamespace;
    DB: D1Database;
    FILES: R2Bucket;
    QUEUE_BRIDGE: Queue;
  }
}
