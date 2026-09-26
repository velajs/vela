---
"@velajs/crud": minor
---

Add explicit request-owned database acquisition with `CrudModule.forRequestAsync`
and `acquireCrudDatabases`. Leases reuse one registry per invocation, release once
after managed work and streaming completion, guard expired adapters and stores,
and reject unjoined concurrent work across aliases of one acquired resource.

Compiled `forFeature` resource tokens now require a managed execution scope and
expire with it. Resolve headless resources with `runInEntrypointScope` or a managed
HTTP child instead of the application root. Application-owned database handles
and standalone `defineResource` remain available. Static registrations retain
bootstrap validation; request factories validate on acquisition.
