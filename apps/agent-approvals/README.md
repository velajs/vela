# Durable agent approvals

Run from the monorepo root with Node 24+:

```sh
pnpm build
pnpm --filter @velajs/agent-approvals-example demo
```

The example needs no API key. It scripts a refund tool call, parks for approval,
loads the persisted challenge, resumes the same workflow log, and redelivers the
logical run through another instance. Assertions prove the refund happened once.

The in-memory store, scripted model, fixed identity, and approval set are testing
adapters. For deployment, supply an atomic persistent `AgentThreadStore`, derive
identity from authenticated trigger metadata, verify approvals through an
authenticated service, and pass the compiled handler a native durable workflow
context. See the [agent package](../../packages/agent/README.md).

## Native Worker

`src/worker.ts` is a deployable, synthetic single-principal approval service.
It runs the same compiled agent through `VelaWorkflow`, persists threads in a
SQLite Durable Object, and uses `InternalDispatcher` to call a `@SignedInvocation`
route. Generation is scripted and the acknowledged action has no external effect;
no model credentials or external APIs are needed.

```sh
pnpm install --frozen-lockfile
pnpm --filter @velajs/agent-approvals-example... build
pnpm --filter @velajs/agent-approvals-example test:workers
pnpm --filter @velajs/agent-approvals-example dev
```

Before local development, create `apps/agent-approvals/.dev.vars` with distinct
random values for `DEMO_TOKEN` and `URL_SIGNING_SECRET`. Before a deployment, set
those secrets with Wrangler. `wrangler.toml` includes the Workflow binding, class
and SQLite migration; `build` only performs a deployment dry run. Deploy explicitly
with `pnpm --dir apps/agent-approvals exec wrangler deploy` when ready.

The demo token authenticates one configured `DEMO_OWNER`/`DEMO_TENANT` and grants
access to every run in that deployment. A multi-user service must replace this
with verified user identity, instance-to-scope admission records, and explicit
read/approval permissions. Trigger payloads never establish identity. The
signed internal route separately verifies the framework invocation signature.

With `Authorization: Bearer <DEMO_TOKEN>`:

1. `POST /runs` with `{ "threadKey": "review-1", "runKey": "request-1", "input": "Review this message" }` returns an instance `id`.
2. `GET /threads/review-1` returns persisted messages. Read the approval placeholder's `nonce`.
3. `POST /runs/<id>/approve` with `{ "threadKey": "review-1", "nonce": "<nonce>", "decision": "approve" }` records the authenticated decision, then sends the native event.
4. `GET /runs/<id>/events` streams retained and live native execution events as SSE. Closing the body cancels and disposes the subscription. Read the thread again for authoritative agent messages.

An identical approval request can be retried after delivery fails. An altered
verdict is rejected. No public route deletes state or abandons run claims. Keep
claims for the entire native replay/delivery retention window. For production,
remote actions must atomically deduplicate the tool's `Idempotency-Key` and thread
histories need an application retention/recovery policy.
