// The environment `wrangler types --include-runtime=false` declares for
// wrangler.test.toml, kept by hand for the workerd suites. @velajs/cloudflare
// extends VelaEnv with Cloudflare.Env, so ENV carries these bindings typed.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('./entry');
  }
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
    SIGNUP_WORKFLOW: Workflow<
      Parameters<import('./entry').SignupWorkflow['run']>[0]['payload']
    >;
    NAP_WORKFLOW: Workflow<Parameters<import('./entry').NapWorkflow['run']>[0]['payload']>;
    PORTABLE_WORKFLOW: Workflow<Parameters<import('./entry').PortableExampleWorkflow['run']>[0]['payload']>;
    PORTABLE_AGENT_WORKFLOW: Workflow<Parameters<import('./entry').PortableAgentWorkflow['run']>[0]['payload']>;
    PORTABLE_PROBE: Service<typeof import('./entry').PortableProbe>;
    BILLING: Service<typeof import('./entry').Billing>;
    TRACING_RPC: Service<typeof import('./entry').TracingRpc>;
    CACHE: KVNamespace;
    DB: D1Database;
    FILES: R2Bucket;
    QUEUE_BRIDGE: Queue;
  }
}
