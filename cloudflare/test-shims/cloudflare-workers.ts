// Node/vitest stand-in for the `cloudflare:workers` runtime module, aliased in
// vitest.config.ts. Provides a concrete `DurableObject` base so the WebSocket
// DO shell can be constructed and exercised with fakes outside workerd.

export class DurableObject<Env = unknown> {
  constructor(
    public ctx: unknown,
    public env: Env,
  ) {}
}

export class WorkerEntrypoint<Env = unknown> {
  constructor(
    public ctx: unknown,
    public env: Env,
  ) {}
}

// Base for a Cloudflare Workflow entrypoint. The real class stores `ctx`/`env`
// as protected fields and is instantiated by the platform; the shim exposes them
// so a generated entrypoint can be constructed with fakes and its `run` driven
// outside workerd.
export class WorkflowEntrypoint<Env = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}
}
