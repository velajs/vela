# Application deployment

Use Wrangler to build and deploy Vela Workers. `vela deploy check` checks a named
target and a saved entrypoint snapshot before those steps:

```sh
pnpm exec vela deploy check \
  --config wrangler.jsonc \
  --env staging \
  --entrypoints build/entrypoints.json
```

All three paths/target flags are required. JSON, JSONC and TOML Wrangler files are
supported; `--env` selects an exact declared name, with letters, digits,
underscores or dashes (starting with a letter or digit). There is no implicit
production target. Add `--json` to capture the result in CI. Exit code 1 means
invalid input or an alignment failure; code 0 means the static checks passed.

The command reads the two files and git provenance. It does not import your
application, call `createApp`, load credentials, execute build hooks, run Wrangler,
apply migrations or upload code. Git's repository filesystem monitor is disabled
for provenance reads. Its printed Wrangler command is a suggested next
step, not an executed operation. Inputs are limited to 1 MiB each.

## Prepare the snapshot

Generate a fresh snapshot from the same application configuration and source
revision you will deploy. Existing introspection produces the supported format:

```sh
pnpm build
mkdir -p build
pnpm exec vela entrypoint list --config vela.config.mjs --json > build/entrypoints.json
```

**Snapshot generation creates the application.** Use a deliberate local/test
configuration with native local bindings and controlled initialization hooks.
Do not use production credentials simply to inspect metadata. The subsequent
deployment check only reads the saved JSON. For an application without metadata
handlers, save `[]`. Unknown entrypoint kinds are tolerated.

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
registration pins with `consumer`, or that a processed queue's producer binding
sends to, fails with `queue-consumer-claimed-by-raw`. A physical queue pinned by
registrations accepts only their jobs, so an unpinned registered queue whose
producer binding sends to it fails with `queue-sent-to-pinned-queue`: pin that
queue to the same physical queue, or send it through another one.

A `@Cron` job that explicitly requests `dialect: 'unix'` or
`timeZone: 'local'` fails with `incompatible-cron-options`, and one that declares
no dialect but whose weekday field has digits or whose day-of-month and weekday
fields are both restricted fails with `ambiguous-cron-dialect`: Workers read its
trigger with Cloudflare semantics while Node reads it with Vela's unix dialect,
so declare `{ dialect: 'cloudflare' }`; `{ dialect: 'unix' }` is only for
Node-only jobs, which are not deployed as Workers. `schedule:interval` fails with
`unsupported-interval` because Workers cron delivery does not drive interval
timers. At runtime the Cloudflare adapter only reports these through the
diagnostics policy (see [scheduling](scheduling.md#workers-cron-triggers)). A
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
  "main": "dist/worker.js",
  "compatibility_date": "2026-09-20",
  "build": { "command": "pnpm build" },
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

The preflight inherits `main`, compatibility settings and triggers from the
top-level configuration, including an explicit empty `crons` override. It does
not inherit resource bindings or variables. When the environment omits `name`,
the displayed worker name is the top-level name with `-<environment>` appended.
KV/D1/R2 IDs may be omitted for Wrangler auto-provisioning; their absence is not
proof that a resource already exists. See Wrangler's
[configuration rules](https://developers.cloudflare.com/workers/wrangler/configuration/).

The binding inventory checks names and selected shapes for vars, KV, D1, R2,
services, Hyperdrive, Vectorize, workflows, analytics datasets, Durable Objects
and queues. Distinct databases of the same engine are valid. Duplicate binding
names fail; gateway bindings must name a Durable Object in the selected target.
Other Wrangler settings and the bindings application code reads from `ENV`
remain Wrangler/application responsibilities. No resource lookup, migration
ownership, cross-database transaction check or cloud authentication occurs here.

Output contains the worker/environment, binding names/types, compatibility
settings, current git commit/dirty state and SHA-256 digests of both input files.
It excludes variable values, resource IDs, arbitrary metadata and custom build
commands. Missing git information is reported as unavailable; dirty state is
reported without blocking local iteration. Digests identify inspected bytes;
they do not prove that a snapshot is fresh or that a bundle ran successfully.

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
Cloudflare credentials. Copy it into an application's workflow directory and
provide that application's `snapshot:entrypoints` script. The snapshot step must
write `build/entrypoints.json` from its local/test application configuration.
Keep source revision, lockfile and application configuration consistent across
test, snapshot, bundle and deployment steps.

After resolving preflight errors, run the pinned project Wrangler separately:

```sh
pnpm exec wrangler deploy --config wrangler.jsonc --env staging --dry-run
```

This Wrangler dry-run can execute custom builds and write local bundle output.
It checks bundling without uploading, and is separate from the static preflight.
Run native Workers tests for cold HTTP/queue/cron and binding behavior. Verify
resource/migration readiness for each named database using your application's
migration tooling before the actual deployment. For D1, apply each database's
own reviewed migrations to its matching staging binding; do not assume a single
database migration covers all registrations.

When ready to deploy, use your approved application pipeline or an explicit
`pnpm exec wrangler deploy --config wrangler.jsonc --env staging`, then run the
application's smoke checks against the resulting URL. Configure Cloudflare
credentials only on the deploy job. Production should select its own named
environment and consume the reviewed revision and configuration. Nothing in the
preflight schedules or authorizes deployment.

Framework npm publication remains a separate process: use [RELEASING.md](../RELEASING.md)
and its exact-archive `release:check`/`release:consumer` gates. Application checks
do not replace package consumer verification.
