# vela — Roadmap

This file tracks vela's own technical direction. Shipped work lives in `CHANGELOG.md`; this doc only covers what's planned next.

## Shipped in 1.11 — the module model

The state-of-the-art module system (see `MODULE_AUTHORING.md`): `defineModule`
(one engine generating `forRoot`/`forRootAsync`, deterministic keys, options-
derived contributions, `global:` slot), `lazyProvider`/`provideGlobal`/
`sideEffectModule`/`moduleToken`, public `DiscoveryService` +
`createDiscoverableDecorator`, the open `EntrypointRegistry`
(`registerEntrypointKind` / `ContributesEntrypoints` / `app.entrypoints`),
`RouteContributor` (CrudBridge generalized + public), `RuntimeAdapter`
(`VelaFactory.create({ adapters })`), `PipelineRunner`, and
`Container.replaceProvider`. WebSocket/storage/auth/testing/crud/cloudflare are
retrofitted; consumer surface stays NestJS-parity (`forRoot`/`forRootAsync`).

## Phase 2 — full retrofit + dispatch semantics

- ~~Migrate the remaining Tier-B in-core modules onto `defineModule`~~ — DONE
  (1.11): Cors + Seeder on `defineModule`; Schedule/ScheduleNode normalized to
  zero-config `@Module` bags (Health/EventEmitter already were; zero-config
  plain `@Module` is itself a blessed path). i18n `registerMessages` keeps its
  shared-marker-class pattern deliberately (dedup semantics `sideEffectModule`
  intentionally doesn't have); comment documents the distinction.
- ~~`createCloudflareApp` re-expressed on `RuntimeAdapter`~~ — DONE (1.11):
  `cloudflareAdapter()` is exported (binding-init as `requestMiddleware`, ref
  collection in `onBootstrap`); `createCloudflareApp` composes it.
- ~~Entrypoint **dispatch** semantics~~ — DONE (1.11):
  `runInEntrypointScope(container, fn)` (request-scoped child + LIFO
  disposal). Validated by real consumers instead of a hypothetical
  QueueModule: `@velajs/cloudflare`'s `@QueueConsumer`/`@Scheduled` (and
  vela `@Cron` via the `cf:vela-cron` cross-package kind) now declare
  entrypoint kinds and dispatch per-event inside a scope — the bespoke
  `scanInstances` queue/cron scans are deleted. Running the dispatch through
  `PipelineRunner` also DONE: `buildEntrypointExecutionContext` +
  consumer-scoped guards/interceptors/filters around every queue/scheduled
  dispatch (`getType()` is already generic over string — no widening needed;
  HTTP-global components deliberately excluded; unclaimed errors rethrow for
  platform retry).

## Phase 3 — platform parity

- ~~**Cold-start laziness**: memoized lazy subsystem init at trigger points.~~
  — DONE: module-level `lazy: true` (`@Module` / `DynamicModule` /
  `defineModule`), claim-at-resolution + drain-at-stack-unwind
  materialization with lifecycle-hook replay, phase-aware bootstrap
  absorption, metadata-only entrypoints for lazy declared kinds, and
  `EventEmitter`/`Schedule`/`Seeder`/`I18n` modules flipped lazy. Spec:
  `docs/superpowers/specs/2026-07-04-lazy-cold-start-init-design.md`.
- **Exception-handler layer**: Laravel-style report/render/dontReport/context
  above the NestJS-style filters; also fixes the silent-500-no-logging path in
  `HandlerExecutor`.
- **CLI introspection** on `DiscoveryService`: `route:list`, module graph,
  entrypoint list, OpenAPI dump in `@velajs/cli`.
- ~~**First-party `QueueModule`** authored 100% on the public API — the
  openness proof (`registerEntrypointKind({ kind: 'queue', ... })`).~~ —
  DONE (1.14): `@velajs/vela/queue` (`@Processor`/`@Process`, `queueToken` +
  `QueueClient`, `inline()` driver, `dispatchQueueJob`), `lazy: true`,
  authored on public exports only (machine-verified by
  `src/__tests__/queue-openness.test.ts`). The proof surfaced and promoted
  exactly two public seams: `resolveScopedComponents` and an injectable
  per-app `EntrypointRegistry`. Spec:
  `docs/superpowers/specs/2026-07-04-queue-module-design.md`.

## Historical: 2026 audit

All 10 findings of `CODE_AUDIT_REPORT.md` closed as of 1.4 (see that file and
CHANGELOG). Later structural follow-ups shipped in 1.11: the two-source
global-component hazard (dead `MetadataRegistry` tier removed; `RouteManager`
is the single source), the `ComponentManager` process-global container
(stateless now), and the triplicated bootstrap-discovery loops
(`DiscoveryService`).
