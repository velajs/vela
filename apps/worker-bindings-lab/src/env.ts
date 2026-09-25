// This lab runs on in-memory bindings and has no Wrangler file, so it declares
// the bindings `wrangler types` would generate for one. @velajs/cloudflare
// extends VelaEnv with Cloudflare.Env, so ENV is typed with them. EVENT_LOG is
// a lab-only list that the event handlers append to.
declare global {
  namespace Cloudflare {
    interface Env {
      CACHE: KVNamespace;
      DB: D1Database;
      ASSETS: R2Bucket;
      JOB_QUEUE: Queue<unknown>;
      REPORT_QUEUE: Queue<unknown>;
      COUNTER_DO: DurableObjectNamespace<import('./worker.js').Counter>;
      AI: Ai;
      VECTORIZE: VectorizeIndex;
      HYPERDRIVE: Hyperdrive;
      EVENT_LOG: string[];
    }
  }
}

export {};
