---
"@velajs/cloudflare": minor
---

**Behavior change:** a `{ create(env) }` or dynamic-module root now resolves once per environment object in an isolate, and the Worker and every `VelaWebSocketDurableObject` instance built from that environment share the resulting module graph. Previously each Durable Object instance (and each direct `createCloudflareApp` call) ran the factory again and registered new classes that the isolate kept for its lifetime, along with any secrets captured in their module options. Applications still get separate providers and lifecycle state, and a rejected factory or failed bootstrap is evicted and retried. Supply objects that bind to one application, such as an in-process queue driver instance, as factories (`driver: () => inline()`).
