// Node stand-in for the `cloudflare:workers` runtime module, aliased in
// vitest.config.ts: the Worker entry's Durable Object class extends it, so the
// entry loads in these Node tests. Real Durable Objects run only in workerd.
export class DurableObject<Env = unknown> {
  constructor(
    protected readonly ctx: unknown,
    protected readonly env: Env,
  ) {}
}
