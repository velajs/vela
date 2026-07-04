# First-party QueueModule — design (roadmap phase 3, "the openness proof")

Branch `feat/queue-module`. Claim marker:
`docs/superpowers/specs/CLAIMED-queue-module.md` (main tree).

## Goal

A platform-agnostic queue subsystem authored on vela's PUBLIC API — proving
the 1.11–1.13 extension points can express a whole feature module with no
kernel reach: `defineModule` (+ `lazy: true`), `createDiscoverableDecorator`,
`registerEntrypointKind({ kind: 'queue', ... })`, `app.entrypoints`,
`runInEntrypointScope`, `buildEntrypointExecutionContext`, `PipelineRunner`,
`shouldFilterCatch`, `moduleToken`, `defineMetadata`/`getMetadata`.

**One gap the proof surfaced (fixed as part of this change):** scoped
component resolution (`@UseGuards`/`@UsePipes`/`@UseInterceptors`/
`@UseFilters` on consumer classes/methods) lives only on the internal
`ComponentManager`. Promote ONE public seam —
`resolveScopedComponents(type, targetClass, methodName, container)` in the
pipeline barrel — mirroring how 1.11 made `RouteManager.getGlobalComponents()`
public for the WS dispatcher. Everything else uses existing public exports;
`src/__tests__/queue-openness.test.ts` machine-verifies that every vela
symbol `src/queue/*` imports is re-exported by `src/index.ts`.

## Model (edge-first, no worker runtime)

Delivery is PUSH: a platform adapter (or the in-process driver) hands a job to
the dispatch primitive. No polling loops, no timers (edge purity: no
`setInterval`, no `node:*`; ids via `crypto.randomUUID()`).

### Consumer surface (NestJS-familiar)

```ts
@Processor('email')                    // class-level discoverable decorator
@Injectable()
class EmailProcessor {
  @Process('welcome')                  // named job handler
  async sendWelcome(job: QueueJob<WelcomePayload>) { ... }

  @Process()                           // wildcard: any job on 'email' without a named handler
  async fallback(job: QueueJob) { ... }
}
```

- `@Processor(queueName)` = `createDiscoverableDecorator<ProcessorMetadata>('vela:queue:processor')`.
- `@Process(jobName?)` = method decorator appending `{ jobName?, methodName }`
  to class-level metadata under `'vela:queue:process'` (same appended-list
  convention as `@Cron`/`@SubscribeMessage`).
- Kind declared at import time next to the decorator:
  `registerEntrypointKind({ kind: 'queue', metaKey: PROCESSOR_KEY, level: 'class' })`.
  Entry meta = `{ queueName }`; handler lookup happens in the dispatcher via
  `getMetadata(PROCESS_KEY, targetClass)` (public).
- Named handler wins over wildcard; multiple processors may share a queue
  (all matching processors receive the job). No matching handler → diagnostics
  warn (log mode), silent skip otherwise — mirrors WS unknown-event parity.

### Producer surface

```ts
QueueModule.forRoot({ queues: ['email', 'billing'] })   // driver defaults to inline()

class SignupService {
  constructor(@Inject(queueToken('email')) private readonly email: QueueClient) {}
  async signup() { await this.email.add('welcome', { userId }); }
}
```

- `queueToken(name)` → `InjectionToken<QueueClient>` memoized per name in a
  module-level Map (`'vela:queue:client:<name>'`) — same token identity across
  HMR re-evals and across `forRoot` instances.
- `QueueClient.add(jobName, data, opts?) → Promise<QueueJob>`;
  `QueueJob = { id, queue, name, data, attempt: 1 }` (id from
  `crypto.randomUUID()`). Options bag kept minimal v1: `{ delayMs? }` —
  drivers MAY honor it (inline driver: ignored with a diagnostics warn once);
  retention/retries are driver concerns, not core API.
- `QUEUE_DRIVER` token; `QueueDriver` interface:
  `{ readonly kind: string; enqueue(job): Promise<void>; bind?(dispatch: (job) => Promise<void>): void }`.
- `inline({ mode: 'immediate' | 'manual' } = { mode: 'immediate' })` in-core
  driver: `immediate` delivers via `queueMicrotask` after `enqueue` resolves;
  `manual` buffers with `.flush(): Promise<number>` (tests). Unbound enqueue
  buffers until bound (bind happens in the module's dispatch service factory,
  which the client chain depends on, so in-process delivery is always bound
  before first `add`).

### Dispatch primitive (what platforms call)

```ts
export async function dispatchQueueJob(
  container: Container, entrypoints: EntrypointRegistry, job: QueueJob,
): Promise<{ handled: number }>
```

For each `entrypoints.ofKind<ProcessorMetadata>('queue')` entry whose
`queueName === job.queue`: pick handler (named → wildcard), then inside
`runInEntrypointScope`: re-resolve the processor BY TOKEN in the scope
(lazy-module + request-scope compatible — landed 1.13 contract: entries from
lazy modules are metadata-only), build
`buildEntrypointExecutionContext('queue', cls, method, job)`, resolve scoped
components via the new public `resolveScopedComponents`, run through
`PipelineRunner` (guards → interceptors → invoke; entrypoint dispatch takes
NO HTTP-global components — cloudflare 1.12 precedent), route errors through
scoped filters via `shouldFilterCatch`; unclaimed errors rethrow (platform
retry semantics — CF precedent).

### Module definition

`defineModule<QueueModuleOptions>({ name: 'Queue', lazy: true, key: (o) =>
stableHash({ queues: o.queues, driver: o.driver?.kind ?? 'inline' }), setup })`
— options-derived contributions: one `{ provide: queueToken(name), useFactory:
(driver, binding) => new QueueClient(name, driver) }` per `queues[]` entry,
`QUEUE_DRIVER` factory (`o.driver ?? inline()`), and a `QueueDispatchBinding`
provider whose factory binds `driver.bind(job => dispatchQueueJob(...))` —
injected by every client so in-process delivery is bound before first `add`.
All providers sync ⇒ `lazy: true` is safe under the landed sync-seam contract
(dogfoods 1.13). `forRootAsync` comes free from `defineModule`.

Binding needs the container + entrypoint registry: the binding factory injects
`Container` and defers `app.entrypoints` access until the first delivery
(dispatch time), reading the per-app registry through a small
`EntrypointRegistryRef` — REJECTED: no public way to reach `app` from DI.
Instead `dispatchQueueJob` takes the registry; the inline driver's bound
dispatch closes over a lazy lookup: `VelaApplication` registers the built
`EntrypointRegistry` in the container at the end of
`callOnApplicationBootstrap`?? — NOT today. RESOLUTION (public-API-only): the
binding factory injects `Container` and `DiscoveryService`; the bound dispatch
resolves processors via `DiscoveryService.providersWithMeta(Processor)`
directly (public, per-app, no registry needed). `dispatchQueueJob` (the
platform-facing helper) keeps the registry-based signature; the inline driver
uses the discovery-based path. Both share one internal `dispatchToProcessors`
core taking a resolved processor list.

### Exports

- New subpath `@velajs/vela/queue` (package.json exports + barrel):
  `QueueModule`, `Processor`, `Process`, `queueToken`, `QueueClient`,
  `QueueJob`, `QueueDriver`, `QUEUE_DRIVER`, `inline`, `dispatchQueueJob`,
  `ProcessorMetadata`, `ProcessMetadata`, `QueueModuleOptions`.
- User-facing symbols also from the main barrel (websocket precedent).
- New public pipeline export: `resolveScopedComponents` (index.ts).

## Non-goals (v1)

Retries/backoff/DLQ (driver policy), delayed delivery in `inline`, a Redis or
CF-Queues driver (downstream packages own platform drivers; cloudflare's
existing `@QueueConsumer`/'cf:queue' stays untouched and unconflicting),
producer-side persistence patterns.

## Tests

`src/__tests__/queue.test.ts`: named/wildcard routing; multi-processor
fan-out; guards/pipes(via args? — no pipes v1: handler takes the raw job)/
interceptors/filters around dispatch incl. unclaimed-error rethrow;
request-scoped consumer deps rebuild per job (runInEntrypointScope); inline
immediate + manual flush; unbound-buffer then bind; queueToken identity across
forRoot dedup; lazy dogfood — QueueModule providers NOT constructed at
create() for an HTTP-only app, materialize on first `add` (client injection)
/ first dispatch; entrypoint kind visible via `app.entrypoints.ofKind('queue')`
with metadata-only entries when consumer modules are lazy.
`src/__tests__/queue-openness.test.ts`: static import audit — every vela
symbol imported by `src/queue/*` must be exported from `src/index.ts`
(except the queue barrel itself); plus edge-audit compliance is covered by
the existing edge-runtime-audit test automatically.

## Verification

vela: `pnpm test` + `pnpm run test:workers` + typecheck + build. Downstream:
additive change — cloudflare (81) + testing (12) suites against rebuilt dist
as sanity. Push `origin HEAD:main` per concurrent-session protocol; update
claim marker to landed; CHANGELOG feat entry; MODULE_AUTHORING gets the
QueueModule as the worked example of the authoring checklist; ROADMAP strikes
the item.

## v2 amendments (adversarial panel reconciliation)

1. **One dispatch path, async-seam (fixes the fatal sync-drain hole).** The
   per-app `EntrypointRegistry` is registered into the container as a global
   token at the end of `callOnApplicationBootstrap()` (new small core seam —
   testing builder + DO slim path inherit it). Both platform and inline
   dispatch use registry entries (TOKEN + meta only, never pre-resolved
   instances) and re-resolve each processor via `scope.resolveAsync(token)`
   inside `runInEntrypointScope` — lazy modules with async providers/hooks
   materialize through `drainAsync`; request-scoped processors rebuild per job.
2. **Pre-registry buffering.** Inline deliveries before the registry token
   exists buffer in the driver; `QueueDispatchBinding` carries a SYNC
   `onApplicationBootstrap` (lazy-seam-safe) that floats a diagnostics-routed
   flush. `add()` after dispose: delivery catch routes to diagnostics.
3. **Error contract split.** Platform-facing `dispatchQueueJob` rethrows
   unclaimed errors (platform retry). Inline `immediate` mode catches and
   routes to container diagnostics (never an unhandledRejection in a detached
   microtask); `manual` `flush()` resolves the delivered count and REJECTS on
   unclaimed handler errors (the awaiter exists there).
4. **`queueToken` is globalThis-anchored** (`Symbol.for('vela:queue:client-tokens:v1')`)
   — HMR-stable identity, same pattern as the kind store. Tokens are minted
   with an `InjectionToken` default factory that THROWS a descriptive
   "queue 'X' is not registered — add it to QueueModule.forRoot({ queues })"
   (turns the typo case into an actionable error).
5. **Lazy claim corrected.** `lazy: true` stays, but the spec/docs state
   plainly: an eager producer injecting a client materializes the module at
   bootstrap (same structural reason WebSocketModule stays eager). The real
   deferral: consumer-only workers (first platform job) and producers behind
   `lazyProvider`/request scope. Tests assert BOTH behaviors explicitly.
6. **forRootAsync: `queues` is STRUCTURAL.** `setup` throws a descriptive
   error when `options.queues` is absent (fail-fast at definition time);
   `key` hashes `{queues, driver kind}`. forRootAsync test added.
7. **Naming: subpath-only.** No queue symbols in the main barrel —
   `@velajs/cloudflare` already exports `QueueModule`/`QueueService`;
   everything lives at `@velajs/vela/queue` (documented divergence from the
   websocket main-barrel precedent + coexistence note for CF users).
8. **Global components: NONE on queue dispatch** (CF queue/scheduled parity;
   deliberate divergence from WS documented in MODULE_AUTHORING + CHANGELOG;
   revisit framework-wide with a transport-tagged globals RFC).
9. **`resolveScopedComponents` preserves `getScopedComponents` order; the
   CALLER reverses filters** (WS/CF convention stays visible).
10. **Duplicate `@Process(jobName)` in one processor: first wins + diagnostics
    warn (throw mode throws).** Same-queue-name across two module instances:
    detected at binding construction via `container.getOwnerModuleIds` →
    descriptive throw; test added.
11. **DX diagnostics:** 'no processor registered for queue X' (log-mode warn,
    distinct from) 'no @Process handler for job Y on queue X'; `delayMs`
    ignored by inline warns once.
12. **Openness audit strengthened:** per-file import parsing checks BOTH that
    the symbol is exported from `src/index.ts` (value or type) AND that the
    specifier resolves to a public entrypoint (`../index`, the queue barrel
    itself, or a declared subpath barrel); `import type` normalized.
