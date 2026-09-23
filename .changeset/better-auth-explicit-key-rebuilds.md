---
"@velajs/better-auth": minor
---

`BetterAuthModule.forRoot({ key })` and `forRootAsync({ key })` no longer throw when a root is rebuilt with the same explicit key in one isolate, for example per Worker environment or per Durable Object. Within an application, the same registration still deduplicates.

**Behavior change:** an explicit `key` no longer rejects a different registration that reuses it within one application. The key now labels a registration instead of claiming it: the options shape and the auth instance (or `useFactory`) stay part of the module's identity, so each distinct registration under the same key, one with a different auth instance, factory or options, becomes its own module instance, as a registration without a key does. Previously the second registration threw. Use distinct keys, or pass the same auth instance or factory and options, when one application should hold a single registration.
