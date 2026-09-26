# @velajs/workflow

## 1.1.0

### Minor Changes

- cdd0b74: Add optional Cloudflare execution and persistence subpaths. Workflow definitions now run inside existing native or Vela workflow hosts with required Standard Schema ingress validation, per-invocation authenticated dispatch injection, native terminal-error conversion, and authorized subscription streams with cancellation cleanup. Native scheduling, replay, subscriptions and deletion remain Cloudflare capabilities.
  
  Native terminal-error conversion now preserves Cloudflare's `NonRetryableError` name; custom portable names prefix the error message instead. Replacing the native name made terminal failures retry across the native serialized error boundary.
  
  Add a SQLite Durable Object AgentThreadStore driver with transactional scope checks, run claims, immutable completion, gap-free message deduplication, and durable approval decisions. Claims remain retained until an application safely recovers or retires them; remote effects still require idempotency.
  
  Change AGENT_APPROVAL_EVENT_TYPE from `agent:approval` to `agent-approval` to satisfy native Cloudflare event-name rules. Update senders/listeners together and drain or separately version existing waits before changing deployments.

## 1.0.2

### Patch Changes

- Updated dependencies [bacaacd]
  - @velajs/errors@1.23.0

## 1.0.1

### Patch Changes

- 098dfea: Migrate the portable workflow runtime and separate replay harness into the monorepo. Adopt Zod 4 input/output inference and unknown dispatch/event boundaries; fix retries, matching event delivery, memoization copies and instance isolation. Document supported APIs and the absence of native Cloudflare Workflows integration, with a runnable approval example and packed-entrypoint consumer verification.

## 1.0.0

Migrate the standalone source into the Vela monorepo. Adopt Zod 4 raw-input and
parsed-output inference, unknown dispatch/event boundaries, typed binding lookup,
and the shared `@velajs/errors`. Add retry, matching-event, memoization-copy and
instance-isolation checks to the portable harness. Preserve the separate
`/harness` entrypoint. Native Cloudflare execution and generated wiring remain
unimplemented; see README for the supported contract and migration notes.

## 0.1.0

Initial release.

- `defineWorkflow` / `defineStep` with brand checks and pure, Node-safe naming
  helpers (`workflowClassName` / `workflowBindingName` / `workflowDefaultName`).
- A step-scoped run context (`createWorkflowRunContext`) whose `ctx.run`
  internal-dispatch seam is an injected structural `WorkflowRunFunction` — the
  package never imports vela core's `InternalDispatcher`.
- `createRunStep` — zod-validated durable steps, converting a deterministic
  `returns` failure into a portable `WorkflowNonRetryableError`.
- `createWorkflows` — the `ctx.workflows` producer surface over structural
  bindings.
- `@velajs/workflow/harness` — an in-memory replay harness proving `step.do`
  memoization and `step.waitForEvent` hibernation with zero Cloudflare tooling.
