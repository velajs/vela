# Product direction: the NestJS experience on Cloudflare Workers

The user's objective is the starting point. Existing repositories, package names,
abstractions, tests, and prepared release archives are implementation evidence;
they are not requirements to preserve. A change earns its place by improving
application authoring, runtime correctness, or development feedback.

The active release line is 1.x. Breaking API changes are acceptable while this
developer experience takes shape. Update the maintained applications with the
framework; do not retain obsolete examples or compatibility layers solely to
preserve earlier APIs.

## The application author's experience

A developer organizes a feature as a module, controller, and service. Constructor
injection wires dependencies. Guards express access rules, pipes parse inputs,
interceptors implement cross-cutting behavior, and exception handling produces
consistent responses. Module imports and exports establish real boundaries.
These are the valuable familiar parts of the [Nest module model](https://docs.nestjs.com/modules)
and [provider model](https://docs.nestjs.com/providers).

The ordinary path should be a small application with a Worker entrypoint and
feature files. Enabling a capability should not require learning unrelated
packages, assembling several drivers, or wrapping all decorated classes in an
environment factory. Advanced composition remains available as an escape hatch.

The intended development workflow is: create a project, run it in the Workers
runtime, inspect it in Studio, test it, and deploy with Wrangler. Commands should
coordinate the actual tools and propagate their failures. Configuration and
generated artifacts must remain inspectable; the framework should not maintain
a second, conflicting Cloudflare configuration system.

## Cloudflare defines execution semantics

Worker invocations and Durable Object instances are distinct ownership scopes.
Application services may be reused only where their state and bindings remain
valid. Request identity and invocation resources must not leak between requests.

D1, KV, R2, Queues, service bindings, and Durable Object namespaces keep their
native APIs and generated environment types. Injection adds convenient access;
it does not justify a wrapper class around every binding. Cloudflare documents
both binding changes within an isolate and the restrictions on I/O outside an
invocation in its [binding guidance](https://developers.cloudflare.com/workers/runtime-apis/bindings/).

Queue and scheduled handlers participate in the same module, DI, authorization
where applicable, and observability model as HTTP, while retaining native ack,
retry, event, and execution-context behavior. Durable Objects remain explicitly
named, individually addressable state owners, following the
[platform's model](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/).
In-memory singleton state is never presented as globally durable state.

## Contracts and development tools

An endpoint's runtime schemas should provide its validation, API description,
and client contract. Runtime reflection cannot recover erased TypeScript types.
The basic documented path must produce a useful typed client without maintaining
separate hand-written response documentation or a shadow client-side model.

An HTTP router is an implementation choice. Keep the existing Hono implementation
when it provides correct routing and integration at an acceptable cost; do not
force application authors to learn its internals for a normal controller.

Studio belongs to the normal development workflow. It should explain the module
graph, routes, bindings, invocation failures, and enabled capabilities. Additional
data or live panels should appear when their integration supplies the necessary
metadata and inspection implementation. State and secrets must retain their
actual ownership and authorization boundaries.

Auth, automatic CRUD, live queries, and database integrations are optional
capabilities. A plain HTTP service should neither configure them nor pay their
startup/bundle cost. Defaults can remove mechanical wiring; security policy,
tenant boundaries, and Durable Object routing must remain explicit.

## Repository and package recommendation

Use one development monorepo. The framework, Workers runtime, tooling, and Studio
need atomic API changes and shared consumer tests. This recommendation follows
the cohesive developer experience; it does not follow the current folder layout.

Keep the basic public install small: the framework and its Workers integration.
Publish optional integrations separately when consumers benefit from independent
installation or dependency isolation. Use subpath exports for implementation
organization that does not warrant another installable package. Browser, Worker,
and Node development tooling must retain separate runtime dependency boundaries.

The current count of 21 packages is not a product requirement or a release goal.
Do not merge all runtime code into one bundle merely because development moves
to one repository. Preserve existing work and Git histories during any migration.

## Acceptance before presenting a stable release as this product

1. From a clean directory, create and run a controller/service/module application
   on workerd with native generated bindings and clear DI errors.
2. Add validated input and output, generate the client, and make a typed call
   without duplicating the contract or loading server code into the browser.
3. Add a queue consumer and a scheduled handler with ordinary feature modules;
   demonstrate native event semantics and invocation isolation.
4. Enable Studio through the normal development workflow and inspect the actual
   running Worker without manually connecting several internal packages.
5. Add auth and a live feature incrementally, with explicit policy and storage
   ownership but a small amount of mechanical setup.
6. Measure the basic app's bundle/startup cost and show that disabled integrations
   are absent. Deploy and test the same application against Cloudflare staging.

## What the current implementation establishes

The existing verification establishes tested DI/schema/runtime boundaries,
functional native Workers/D1 integration, a working complete application, and
installable tarballs. It is valuable implementation work.

The current starter also exposes product gaps: many feature modules and transport
drivers must be assembled manually; all decorated feature classes live inside an
environment factory; contract generation constructs a graph with placeholder
bindings; general CRUD response types remain unknown; and the CLI has inspection,
client generation, and Studio commands but no project creation or coordinated
development command. These observations come from the starter and CLI source,
not from a fresh review of every subsystem.

The next design work should simplify this authoring path and use the acceptance
flows above to decide what to retain, combine, replace, or remove. The prepared
archives are a verified snapshot, not proof that those product acceptance flows
are complete. The user's commit/release request remains outstanding.
