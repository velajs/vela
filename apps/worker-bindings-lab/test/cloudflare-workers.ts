// Node stand-in for the `cloudflare:workers` runtime module, aliased in
// vitest.config.ts: the Worker entry's Durable Object, Workflow and service
// entrypoint classes extend these, so the entry loads in these Node tests.
// Real Durable Objects and Workflows run only in workerd.
export class DurableObject<Env = unknown> {
  constructor(
    protected readonly ctx: unknown,
    protected readonly env: Env,
  ) {}
}

export class WorkflowEntrypoint<Env = unknown> {
  constructor(
    protected readonly ctx: unknown,
    protected readonly env: Env,
  ) {}
}

export class WorkerEntrypoint<Env = unknown> {
  constructor(
    protected readonly ctx: unknown,
    protected readonly env: Env,
  ) {}
}
