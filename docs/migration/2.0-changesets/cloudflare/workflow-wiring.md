---
"@velajs/cloudflare": minor
---

Add Cloudflare Workflows wiring over `@velajs/workflow`'s neutral core.

- `WorkflowModule.forRoot({ workflows })` declares each `defineWorkflow` export once: it registers a `BindingRef` per workflow (auto-initialized by the existing adapter binding-init path), provides the injectable `WorkflowsService` (`ctx.workflows` producer over `createWorkflows`), and contributes each workflow as a new `cf:workflow` `EntrypointKind` through a `ContributesEntrypoints` provider (`WorkflowRegistry`) — discoverable via `app.entrypoints.ofKind('cf:workflow')`.
- `createWorkflowEntrypoint(def, { rootModule, name })` / `createWorkflowEntrypoints(workflows, { rootModule })` produce the platform `WorkflowEntrypoint` classes (named to match wrangler `class_name`), mirroring the `VelaWebSocketDurableObject` re-export pattern.
- `buildWorkflowRuntime` boots the app in the entrypoint isolate and supplies a real cross-isolate `InvocationTransport` for `ctx.run` over a self-service binding (default `SELF`), failing closed when the binding is absent. NonRetryableError translation is applied on all three paths (top-level handler throw, `step.do` interior, and `ctx.run` deterministic-4xx → non-retryable while 5xx stays retryable).

Adds `@velajs/workflow` as a peer dependency, a `cloudflare:workflows` test shim + vitest alias, and a `tsconfig.test.json` so the new tests are type-checked.
