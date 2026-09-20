---
'@velajs/vela': major
---

Add schema-bound `defineEndpoint` and `@Endpoint` contracts. HTTP ingress parses the schema's parameter, query, header, and JSON groups after guards; final interceptor output is validated before being sent at the declared status and format. OpenAPI and Hono RPC generation consume the same schemas. Conflicting parameter and response decorators are rejected during bootstrap.

Verified request identity now carries immutable roles, claims, and expiry shared across authentication providers and authorization. Execution pipelines always authorize before extracting arguments.

Core Hono contexts expose opaque platform bindings and unknown application variables. Typed bindings come from the configured environment token. Request containers live in private request storage; integrations use `getRequestContainer` instead of a Hono string variable. Source and emitted-package negative tests protect these boundaries.

Provider registration now requires a class or checked `defineProvider` descriptor. Factory dependencies require an explicit `inject` tuple, and token resolution infers its result. Config values are unknown until parsed; `registerAs` requires a typed environment token. DTOs use schema descriptors rather than empty generated constructors. Module builder transitions return independent branches, and entrypoint metadata requires a parser before it can expose typed fields.
