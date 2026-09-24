---
'@velajs/vela': minor
'@velajs/cloudflare': minor
---

Bindings are referenced by name and resolved from each application's `ENV` when used. `@velajs/vela/module-kit` adds the seam: `BindingRef` (`{ binding: 'CACHE' }`), `BindingKind` (what a binding is and the configuration key that declares it), `resolveBinding(env, ref, kind)`, `defineBinding(kind)` for lower-camel binding factories, the `EnvFactory<T>` type for option values an application builds from its own `ENV`, and `readEnv(container)` for module providers. A missing binding fails with `ENV.CACHE is not set: declare the KV namespace binding 'CACHE' under kv_namespaces …`; a binding of another kind fails naming the same key.

`@velajs/cloudflare` exports the Workers binding factories built on it: `kv`, `r2`, `d1`, `queue`, `durableObject` and `rateLimit`. `kv({ binding: 'CACHE' })` reads no environment when declared; calling it with an application's `ENV` returns the typed native binding. The Cloudflare Queues driver, `durableObjectLive()` and the Worker's WebSocket upgrade forwarding resolve their bindings through the same seam instead of reading `env[binding]` themselves.

**Behavior change:** a send to a registered queue whose producer binding is missing or is not a producer rejects with `Queue 'email' cannot send: ENV.EMAIL_QUEUE is not set: …` (or `… is not a binding of type queue producer …`) instead of the previous wording. A WebSocket upgrade for a gateway whose Durable Object binding is missing now fails through the application's error handler, reported and answered with the redacted 500 body, instead of a plain-text 500 response.
