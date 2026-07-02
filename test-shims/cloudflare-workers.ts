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
