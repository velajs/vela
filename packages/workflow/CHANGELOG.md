# @velajs/workflow

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
