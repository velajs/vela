# Application deployment

Build Vela Workers with Vite and deploy the build with Wrangler. `vela deploy check`
compares a Wrangler target with the application's entrypoints before those steps:

```sh
pnpm exec vela deploy check                 # the top-level configuration
pnpm exec vela deploy check --env staging   # a named environment
pnpm exec vela deploy check \
  --config wrangler.jsonc \
  --env staging \
  --entrypoints build/entrypoints.json      # a saved snapshot: no application code runs
```

Without `--config`, the command reads `wrangler.json`, `wrangler.jsonc` or
`wrangler.toml` in the working directory; JSON, JSONC and TOML files are
supported. Without `--env` it checks the top-level configuration; `--env`
selects an exact declared name, with letters, digits, underscores or dashes
(starting with a letter or digit). Add `--json` to capture the result in CI.
Exit code 1 means invalid input or an alignment failure; code 0 means the static
checks passed.

The command reads the Wrangler file and git provenance. Git's repository
filesystem monitor is disabled for provenance reads. Without `--entrypoints`, it
also builds the application to read its entrypoints: from `vela.config` when the
project has one, else from the Worker entry the selected environment's `main`
names (see [tooling](tooling.md#the-cli-loop)), with `ENV` seeded from the
Wrangler `vars` only, no bindings or secrets. It never loads credentials,
executes build hooks, runs Wrangler, applies migrations or uploads code. Its
printed Wrangler command is a suggested next step, not an executed operation.
Inputs are limited to 1 MiB each.

## Saved snapshots

Pass `--entrypoints` to check a snapshot made earlier, for example in a CI job
that must not import the application. Generate it from the same application
configuration and source revision you will deploy:

```sh
mkdir -p build
pnpm exec vela entrypoint list --json > build/entrypoints.json
```

The CLI loads the Worker entry (or `vela.config.ts`) and the decorated sources it
imports through Vite, with the same Oxc decorator settings as the Worker build,
so no build runs first.

**Snapshot generation creates the application**, with the Wrangler `vars` as
`ENV` unless a `vela.config` builds it otherwise, and runs its initialization
hooks. Do not use production credentials simply to inspect metadata. The check
with `--entrypoints` only reads the saved JSON. For an application without
metadata handlers, save `[]`. Unknown entrypoint kinds are tolerated.

Rows have `{ "kind": "schedule:cron", "target": "Jobs#run", "meta": "{...}" }`.
An object-valued `meta` is also accepted, which is useful when projecting
`app.entrypoints.all()` in a build/test script. Use existing discovery to make the
snapshot; do not build a second decorator scanner. For example:

```json
[
  {
    "kind": "schedule:cron",
    "target": "Jobs#hourly",
    "meta": { "expression": "0 * * * *", "methodName": "hourly", "dialect": "cloudflare" }
  },
  {
    "kind": "cf:queue",
    "target": "Jobs#process",
    "meta": { "queueName": "jobs-staging", "methodName": "process" }
  },
  {
    "kind": "queue:registration",
    "target": "InjectionToken(vela:queue:client:email)",
    "meta": { "name": "email", "binding": "EMAIL_QUEUE", "consumers": [] }
  }
]
```

The check compares exact cron strings for `schedule:cron` (every `@Cron` job),
queue names for `cf:queue`, and gateway bindings for `websocket`. Missing
triggers/consumers and configured triggers/consumers with no metadata handler
fail.

When the snapshot is computed from the Worker entry, it also lists the
[Durable Object](durable-objects.md) classes `@velajs/cloudflare` built as
`cf:durable-object` rows: each exported class by its export name (Wrangler's
`class_name`), with what it serves (`host` and its host class, or `websocket`)
and its RPC methods, and each class the app defines with `VelaDurableObject(app,
Host)` or `VelaWebSocketDurableObject(app)` but the entry does not export, as
`(not exported) <Host>`. An exported class that no `durable_objects` binding of
the selected environment names warns with `unbound-durable-object` (another
Worker may bind it through `script_name`), and a class the entry does not export
warns with `unexported-durable-object`: nothing can bind it.

Queues registered with `QueueModule.registerQueue()` appear as
`queue:registration` rows. Each registered `binding` must be a
`queues.producers[].binding` of the selected environment
(`missing-queue-producer`). When the application consumes natively through
`cloudflareQueues()` (a `cf:queue:module` row), every `@Processor` queue must be
registered (`unregistered-queue-processor`) and must reach this Worker through a
`queues.consumers` entry: the physical queues its registration pins with
`consumer`, or else the `queue` of its binding's producer
(`missing-queue-consumer`). A processed queue with neither fails with
`queue-processor-without-consumer` when the environment consumes no other queue,
and otherwise warns with `unverified-queue-consumer`, because a shared consumer
may carry it. A configured consumer that no `@QueueConsumer` or processed queue
expects fails with `unhandled-queue-consumer`.

A `@QueueConsumer` owns its physical queue's batches, so the module consumer
never sees them. A physical queue that a `@QueueConsumer` claims and that a
registration pins with `consumer`, or that any registered queue's producer
binding sends to, whether or not the Worker processes that queue, fails with
`queue-consumer-claimed-by-raw`. A physical queue pinned by
registrations accepts only their jobs, so an unpinned registered queue whose
producer binding sends to it fails with `queue-sent-to-pinned-queue`: pin that
queue to the same physical queue, or send it through another one. Likewise, a
registration with both a `binding` and `consumer` pins accepts its jobs only
from those pins, so a producer binding that sends to any other physical queue
fails with `queue-producer-outside-pins`.

A `@Cron` job that explicitly requests `dialect: 'unix'` or
`timeZone: 'local'` fails with `incompatible-cron-options`, and one that declares
no dialect but whose weekday field has digits or whose day-of-month and weekday
fields are both restricted fails with `ambiguous-cron-dialect`: Workers read its
trigger with Cloudflare semantics while Node reads it with Vela's unix dialect,
so declare `{ dialect: 'cloudflare' }`; `{ dialect: 'unix' }` is only for
Node-only jobs, which are not deployed as Workers. `schedule:interval` fails with
`unsupported-interval` because Workers cron delivery does not drive interval
timers. At runtime the Cloudflare adapter only reports these through the
diagnostics policy (see [scheduling](scheduling.md#workers-cron-triggers)).
A `@Cron` job that declares `@UseGuards` on its class, method or module fails
with `scheduled-job-guards` unless `ScheduleModule.forRoot({ dispatch: { kind:
'signed', ... } })` re-enters a signed route for it: guards do not run for
directly dispatched scheduled jobs, so the Worker refuses to run such a job on
every trigger. `vela entrypoint list --json` marks those rows with
`guards: true`, and every scheduled row with `dispatch: 'signed'` under signed
dispatch. A
snapshot that still lists the removed `cf:scheduled`, `cf:vela-cron` or
`cf:queue:producer` kinds, or a `cf:queue:module` consumer mapping, was made by
an older CLI and fails with `stale-entrypoint-snapshot`: regenerate it.
Custom hand-written platform handlers are not represented by these metadata
kinds; review them separately instead of treating a snapshot mismatch as a
Wrangler error.

Cron validation uses the core Cloudflare dialect and UTC. Equivalent expressions
such as `0 0 * * SUN` and `0 0 * * 1` must still match literally because Vela's
Workers dispatcher matches the delivered expression. See Cloudflare's
[cron syntax](https://developers.cloudflare.com/workers/configuration/cron-triggers/#supported-cron-expressions).
The shared parser also accepts native last-day offsets such as `0 0 L-1W FEB *`,
described in Cloudflare's [Saffron parser article](https://blog.cloudflare.com/using-one-cron-parser-everywhere-with-rust-and-saffron/).

## Configure staging

Keep real staging resources separate from production. An example target is:

```jsonc
{
  "name": "my-api",
  "main": "src/worker.ts",
  "compatibility_date": "2026-09-20",
  "env": {
    "staging": {
      "name": "my-api-staging",
      "triggers": { "crons": ["0 * * * *"] },
      "queues": { "consumers": [{ "queue": "jobs-staging" }] },
      "d1_databases": [
        { "binding": "ACCOUNTS", "database_name": "accounts-staging" },
        { "binding": "AUDIT", "database_name": "audit-staging" }
      ],
      "vars": { "APP_ORIGIN": "https://my-api-staging.example.com" }
    }
  }
}
```

With `--env`, the preflight inherits `main`, compatibility settings and triggers from the
top-level configuration, including an explicit empty `crons` override. It does
not inherit resource bindings or variables. When the environment omits `name`,
the displayed worker name is the top-level name with `-<environment>` appended.
KV/D1/R2 IDs may be omitted for Wrangler auto-provisioning; their absence is not
proof that a resource already exists. See Wrangler's
[configuration rules](https://developers.cloudflare.com/workers/wrangler/configuration/).

The binding inventory checks names and selected shapes for vars, KV, D1, R2,
services, Hyperdrive, Vectorize, workflows, analytics datasets, Durable Objects
and queues. Distinct databases of the same engine are valid. Duplicate binding
names fail; gateway bindings must name a Durable Object in the selected target,
and the Durable Object classes the Worker exports are expected to be bound in
it.
Other Wrangler settings and the bindings application code reads from `ENV`
remain Wrangler/application responsibilities. No resource lookup, migration
ownership, cross-database transaction check or cloud authentication occurs here.

Output contains the worker/environment, binding names/types, compatibility
settings, current git commit/dirty state and SHA-256 digests of the Wrangler file
and of the snapshot (saved, or computed from the application).
It excludes variable values, resource IDs, arbitrary metadata and custom build
commands. Missing git information is reported as unavailable; dirty state is
reported without blocking local iteration. Digests identify inspected bytes;
they do not prove that a snapshot is fresh or that a bundle ran successfully.

## Build with Vite

Projects created by `vela new` build with Vite 8 and `@cloudflare/vite-plugin`.
`wrangler.jsonc` points `main` at `src/worker.ts` and has no `build` block:

- `pnpm build` (`vite build`) compiles the Worker with Oxc, including the legacy
  decorators and `design:paramtypes` metadata that constructor injection reads,
  and writes it with a generated `wrangler.json` to `dist/<worker>/`. It also
  writes `.wrangler/deploy/config.json`, which redirects Wrangler to that output.
- `pnpm exec wrangler deploy`, with no `--config`, follows the redirect and
  uploads the built Worker. `pnpm run deploy` runs both steps.
- The Wrangler environment is chosen when building: `CLOUDFLARE_ENV=staging
  pnpm build` flattens `env.staging` into the generated configuration, so the
  following `wrangler deploy` targets the staging Worker. Build once per target.

Do not pass `--config wrangler.jsonc` to `wrangler deploy` for such a project:
an explicit configuration bypasses the redirect, and Wrangler then bundles
`src/worker.ts` itself with esbuild, which emits no decorator metadata. The
application would then fail at startup with `MissingInjectionMetadataError`.

The Vite build also copies `.dev.vars` into `dist/<worker>/` so `pnpm preview`
can serve the build with local secrets. Wrangler does not upload it, and the
starter's ignore file excludes `dist/`; do not publish `dist/` any other way.
Vite does not minify the Worker by default. If you enable `build.minify`, also
set `build.rolldownOptions.output.keepNames: true` so class names, which appear
in module ids and diagnostics, survive. See [tooling](tooling.md#build-pipeline).

## Environment types and secrets

The Worker's bindings, variables and secrets reach DI as the framework `ENV`,
typed by the `Cloudflare.Env` that `wrangler types --include-runtime=false`
writes to `worker-configuration.d.ts`. Regenerate and commit it whenever the
Wrangler file changes; `wrangler types --check` fails when it is stale. The
generated types follow the file's top-level bindings, so an environment that
declares different bindings needs the application to tolerate both shapes, or
its own generated types (`wrangler types --env staging`).

Framework features read their secrets from `ENV` without extra wiring:
`URL_SIGNING_SECRET` for signed URLs and signed invocations, and
`VELA_STUDIO_TOKEN` (plus the `VELA_STUDIO_*_EDITABLE` flags) for Studio. Set
them per environment with `pnpm exec wrangler secret put <NAME> --env staging`;
Studio stays closed and signed routes fail closed while they are unset.

## CI and deployment

The [opt-in check workflow](examples/deployment-check.yml) runs checks without
Cloudflare credentials. Copy it into an application's workflow directory. The
check builds the application from the checked-out source to read its
entrypoints, and `vela cf sync` fails when the Wrangler file no longer matches
the application's triggers, queues, Durable Objects and Workflows. Keep source
revision, lockfile and application configuration consistent across test, check,
bundle and deployment steps.

After resolving preflight errors, build the target with Vite and run the pinned
project Wrangler separately, from the directory that holds the Wrangler file:

```sh
CLOUDFLARE_ENV=staging pnpm build
pnpm exec wrangler deploy --env staging --dry-run
```

This dry-run writes local bundle output and checks the upload without performing
it; it is separate from the static preflight. Wrangler follows the redirect the
Vite build wrote and fails when `--env` names another environment than the one
built. `vela deploy check` prints these two commands, after a `cd` into the
Wrangler file's directory, as its `Next step` when a Vite build left
`.wrangler/deploy/config.json` or a `vite.config.*` beside the Wrangler file
references `@cloudflare/vite-plugin`; its `--json` report lists the build as
`nextStep.build`, and both steps carry that directory as `cwd`. The plugin reads
`wrangler.json`, `wrangler.jsonc` or `wrangler.toml` unless its `configPath`
option names another file, so checking a differently named Wrangler file adds a
`vite-config-path` warning. Without `--env`, the commands are `pnpm build` and
`pnpm exec wrangler deploy --dry-run`. For a Worker that Wrangler builds itself,
it prints `wrangler deploy --config <file> [--env <name>] --dry-run` instead.
Run native Workers tests for cold HTTP/queue/cron and binding behavior. Verify
resource/migration readiness for each named database using your application's
migration tooling before the actual deployment. For D1, apply each database's
own reviewed migrations to its matching staging binding; do not assume a single
database migration covers all registrations.

When ready to deploy, use your approved application pipeline or an explicit
`CLOUDFLARE_ENV=staging pnpm build && pnpm exec wrangler deploy --env staging`, then run the
application's smoke checks against the resulting URL. Configure Cloudflare
credentials only on the deploy job. Production should select its own named
environment and consume the reviewed revision and configuration. Nothing in the
preflight schedules or authorizes deployment.

Framework npm publication remains a separate process: use [RELEASING.md](../RELEASING.md)
and its exact-archive `release:check`/`release:consumer` gates. Application checks
do not replace package consumer verification.
