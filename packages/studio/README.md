# @velajs/studio

The edge-safe [Vela Studio](https://github.com/velajs/vela/tree/main/packages/studio) admin module: mounts the
reserved `/_vela/admin` surface, hosts `@AdminRpc` operations, and exposes the time-travel
port. Subpath exports (`./auth`, `./flags`, `./queue`, `./live`, `./schedule`,
`./timetravel`) scope the per-feature admin surfaces.

Protocol v2 exposes the usable operation catalog through `studio.capabilities`.
Only configured Studio handlers enable their features. Queue depth/DLQ/replay
remain unavailable until their handlers are implemented. Live and presence
inspection are enabled by `StudioLiveModule.forRoot({ source })`, where
`source.inspect()` returns the application's explicitly scoped subscription and
room snapshots. With no source they remain disabled. For Cloudflare, call
`inspectLive()` on known room Durable Object stubs; there is no global room list.
CRUD reads and single writes use the adapter's request scope. Bulk mutations require
transaction support, exposed as `supports.bulkWrites` in model descriptors.

`api.authorizeTryIt` checks permissions and audits authorization; the local host then
sends the API request over actual Worker HTTP. Studio does not dispatch that request
through an in-process Hono instance. The host and browser validate the protocol at
their boundaries, including all operation-specific RPC response fields.

Portable and Cloudflare time-travel modules accept `imports` for the configured
Studio/model-source modules that export their dependencies. Async module factories
must supply `inject`, including `inject: []` when no dependencies are needed.

## License

MIT
