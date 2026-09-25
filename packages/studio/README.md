# @velajs/studio

The edge-safe [Vela Studio](https://github.com/velajs/vela/tree/main/packages/studio) admin module: mounts the
reserved `/_vela/admin` surface, hosts `@AdminRpc` operations, and exposes the time-travel
port. Panels join through one contract, `StudioModule.forRoot({ plugins: [...] })`,
each from its own subpath so optional peers stay optional:

```ts
import { StudioModule } from '@velajs/studio';
import { crudPanel } from '@velajs/studio/crud';
import { queuesPanel } from '@velajs/studio/queue';
import { livePanel } from '@velajs/studio/live';
import { logsPanel } from '@velajs/studio/logging';

StudioModule.forRoot({
  editable: { ops: true },
  plugins: [
    crudPanel({ managedModels: { include: ['todo'] } }),
    queuesPanel(),
    livePanel({ rooms: ['default'] }),
    logsPanel({ timings: true }),
  ],
});
```

| Panel | Subpath | Lights |
| --- | --- | --- |
| `crudPanel({ managedModels?, runAsIdentity? })` | `./crud` | `data`, `transfer` |
| `timeTravelPanel({ store?, changeSource?, perPage?, imports? })` | `./timetravel` | `timeTravel` (portable snapshots) |
| `cloudflareTimeTravelPanel({ binding, shardKey? })` | `./cloudflare` | `timeTravel` (Durable Object PITR) |
| `authPanel()` | `./auth` | `auth`, `authOrganizations` |
| `flagsPanel()` | `./flags` | `flags` |
| `queuesPanel()` | `./queue` | `queue` |
| `schedulePanel()` | `./schedule` | `schedule` |
| `livePanel({ rooms?, source? })` | `./live` | `live`, `presence` |
| `logsPanel({ timings? })` | `./logging` | `logs` capture |

Each plugin's providers register in StudioModule's own scope, so they reach its
signers and buffers without re-importing the configured module. `plugins` is
structural: `forRootAsync({ plugins, useFactory })` takes it next to the factory.
Options that depend on the runtime environment take a function of the
application's `ENV` (`livePanel({ source: (env) => … })`,
`timeTravelPanel({ store: (env) => … })`), called once per application; the
Cloudflare time-travel panel names its Durable Object binding and reads it from
`ENV` when a call first needs it. `defineStudioPlugin({ name, providers, imports })`
builds a custom panel; each name appears once.

Studio stays closed until it has a master token: `StudioModule.forRoot({ token })`,
or a `VELA_STUDIO_TOKEN` variable or secret in the application's `ENV`. The
`VELA_STUDIO_DATA_EDITABLE`, `VELA_STUDIO_SCHEMA_EDITABLE`, `VELA_STUDIO_OPS_EDITABLE`,
`VELA_STUDIO_TIMETRAVEL_EDITABLE` and `VELA_STUDIO_TRANSFER_EDITABLE` flags open write
categories the same way; module options win over environment values, and non-string
values are ignored. On Workers `@velajs/cloudflare` seeds `ENV`, so a Wrangler secret
takes effect without extra wiring; elsewhere pass `VelaFactory.create(App, { env })`.
Studio reads the `ENV` the runtime seeds, else the one a `@Global()` module exports
to every module; an `ENV` a module registers for itself or its importers leaves
Studio closed. `readStudioEnv(env)` parses these values and
`resolveStudioConfig(envConfig, options)` merges them under module options.

The protocol exposes the usable operation catalog through `studio.capabilities`.
Only configured Studio handlers enable their features. Queue depth/DLQ/replay
remain unavailable until their handlers are implemented. Live and presence
inspection are enabled by `livePanel({ rooms: ['default'] })`, which reads each
named room through `LiveModule`'s `LiveInspector`: on Cloudflare the room's
Durable Object, through the gateway binding the live driver delivers to;
elsewhere the application's own engine. There is no global room list, so name
each room; the sockets of a gateway without `roomParam` join its path, so name
that path for them. `livePanel({ source })` takes a custom source whose
`inspect()` returns explicitly scoped subscription and room snapshots instead,
or a function that builds it from the application's `ENV`. With neither, the
features remain disabled.
CRUD reads and single writes use the adapter's request scope. Bulk mutations require
transaction support, exposed as `supports.bulkWrites` in model descriptors.

`api.authorizeTryIt` checks permissions and audits authorization; the local host then
sends the API request over actual Worker HTTP. Studio does not dispatch that request
through an in-process Hono instance. The host and browser validate the protocol at
their boundaries, including all operation-specific RPC response fields.

The portable time-travel panel uses the model source a `crudPanel()` binds in the
same Studio; `timeTravelPanel({ imports: [SourceModule] })` reaches a model source
another module exports. Each port is bound by one panel: `timeTravelPanel()` and
`cloudflareTimeTravelPanel()` both bind `TIME_TRAVEL_PORT`, so `forRoot` fails
when a Studio lists both, as it does for any token two plugins provide
(application-wide enhancers such as `APP_INTERCEPTOR` excepted), for a
plugin providing a token StudioModule provides itself, such as
`STUDIO_RESOLVED_CONFIG` or `AdminAuditLog`, and for one providing a framework
token Studio reads from the application (`ENV`, `APP_LOGGER`, `ROOT_MODULE`,
`Container`, `DiscoveryService` or `EntrypointRegistry`). Studio and its panels
read those tokens application-wide, as `app.get()` does, so what the modules a
plugin imports export to their importers never answers for them. An explicit
application registration, such as a seeded `ENV`, answers first; a `@Global()`
module exporting `ROOT_MODULE` or `DiscoveryService`, one a plugin imports
included, overrides that framework default for the whole application, `app.get()`
and Studio alike. Bootstrap fails when a `@Global()` module exports another
`Container`, since Studio would read that container's `ENV` and admin token. The
admin routes read Studio's own tokens, such as `STUDIO_RESOLVED_CONFIG`, in
StudioModule's scope, so another module's registration of one is never used. A
custom panel's provider that injects a framework token directly resolves it in
Studio's scope, where every plugin's imports are visible;
`moduleRef.get(TOKEN, { strict: false })` reads the application's. An async Studio
factory with parameters supplies them through `inject`; one without parameters
may omit it.

## Diagnostic snapshots

Application inspection reads public module, route and entrypoint snapshots. It does
not enumerate provider internals. Entrypoint metadata is bounded to depth 8, 64
items per collection, 256 visited values and 16 KiB of text (2 KiB per string).
Bigints become strings such as `42n`; cycles, accessors, functions, instances and
truncated data use explicit markers. Getters and `toJSON` are never called.
These are diagnostic summaries, not a data export format. Captured route
descriptions are copied so inspection cannot mutate the stored descriptions.

## Structured logs and timings

Add `logsPanel({ timings: true })` from `@velajs/studio/logging` to Studio's
plugins next to `LoggingModule.forRoot()`; without the logging module the
application fails to boot, naming it. Capture reads
only that application's `APP_LOGGER` records after normalization and redaction;
it unsubscribes on application shutdown. It never patches global console methods.
Timing is optional and defaults off. Rows measure handler/inner-interceptor
completion, excluding guards, argument validation, streaming, and deferred work.
They include module ownership and managed invocation IDs when available.

`AdminLogBuffer` copies input and output snapshots, bounds fields and messages,
and accepts capacity zero to disable retention. Records are per application
instance and ephemeral. The Modules and Entrypoints panels also display available
ownership and effective class-token scopes without constructing providers.

See the [debugging guide](../../docs/debugging.md) for setup and debugger recipes.

## Named databases

The CRUD binding uses the same database selection as Vela CRUD. Named resources
appear as `encodeURIComponent(database)::encodeURIComponent(resourceKey)`; a
resource key defaults to the model name. Use that complete identity in row,
transfer, snapshot and `crudPanel({ managedModels })` requests. Unique unnamed models retain
their existing names. Model/table include or exclude rules still match all
namespaces; use a qualified identity to select one. Missing named databases and
colliding identities fail closed, without borrowing the default adapter.

Descriptors retain the physical table and include optional `database` metadata.
Relation targets and generated foreign keys stay within the selected namespace.
Snapshots can restore qualified resources, but the current CDC source contract
accepts only physical table names. Named-database time-based replay is therefore
unavailable and rejected before restore writes; use an explicit snapshot mark.

## License

MIT
