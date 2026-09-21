# Portable workflow lab

Run an order approval workflow locally with Node 24+:

```sh
pnpm install
pnpm --filter @velajs/workflow... build
pnpm --filter @velajs/example-workflow-lab start
```

The script asserts that the workflow suspends for approval, validates the event
payload, retries a temporary dispatch failure, and skips completed effects on
replay. A reusable step transforms its string amount into a number and validates
the unknown dispatch response with Zod 4.

This uses an in-memory testing adapter and an injected dispatch double. It does
not create native Cloudflare Workflows, persist data, or contact a payment service.
See the [package contract](../../packages/workflow/README.md) for adapter boundaries
and production idempotency requirements.
