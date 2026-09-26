# Invocation ownership

Use `DiscoveryService.getRegistrations`, `registrationsWithMeta`, or
`registeredMethodsWithMeta` for dispatch. `{ metadataOnly: true }` returns each
registration's required `moduleId` and effective scope without constructing it.

Resolve an entrypoint with `await resolveEntrypoint(scope, entry)`. Resolve its
decorated components with `resolveScopedComponentsAsync(kind, target, method,
scope, entry.moduleId)`. Explicit global lists can use
`resolvePipelineComponents(kind, entries, scope)`. Keep one pipeline and choose
the transport's global-component policy explicitly.

For non-HTTP work, `runInEntrypointScope(root, async (scope, lifetime) => ...)`
creates and finalizes a child. `lifetime.defer(callback)` starts work after the
handler settles; `lifetime.waitUntil(promise)` tracks already-started work.
Nested managed work is drained before disposal, and failures remain observable.
The injectable `EXECUTION_LIFETIME` exposes correlation, cooperative cancellation,
and managed work registration. It does not confer authentication authority.

HTTP owns its existing child until both the response body and managed work
settle. An HTTP-mounted integration reuses that child and must not finalize it.
Lower-level transport adapters can use `createExecutionScope(root, { signal })`
and `finishExecutionScope(child, bodyCompletion)`; completion is idempotent and
the first call selects the body boundary. Aborting a signal does not dispose
resources while active work still uses them.

Do not fabricate `REQUEST_CONTEXT` for queue, cron, or socket work. Do not copy
tenant IDs or principals from event payloads, correlation IDs, or mutable Hono
variables into trusted identity. Authentication and tenant admission remain
explicit server-side steps. Preserve the original request when an authenticated
HTTP transport invokes another framework pipeline.

Use the canonical context identity APIs from `@velajs/vela/module-kit`:
`getTrustedContextIdentity`, `setTrustedContextIdentity`,
`clearTrustedContextIdentity`, and `setTrustedContextTenant` (CAS against the original
snapshot). They reuse `TrustedRequestIdentity`. HTTP/bound HTTP contexts delegate to
the original request; native contexts require the exact live managed scope. Never
inherit authority from a root, sibling or parent. Clear before verification and
publish only after success. Claims are frozen; replacement, observed expiry,
completion and direct scope/root disposal invalidate authority. Managed deferred
work retains access only while its scope stays valid. Recheck exact identity
references after asynchronous admission or authorization.
