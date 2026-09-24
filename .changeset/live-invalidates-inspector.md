---
'@velajs/vela': minor
'@velajs/cloudflare': minor
'@velajs/studio': minor
---

Add `@LiveInvalidates(tags, { room? })` to `@velajs/vela/live`. It runs as an interceptor on a handler: after the handler succeeds it invalidates the tags, static or derived from the result and the execution context (`(result, context) => tags`, where `[]` skips the invalidation), and stamps `Vela-Commit-Cursor` / `Vela-Commit-Epoch` on the handler's HTTP response through `switchToHttp().getResponse()`, or on a `Response` the handler returns. A mutation no longer needs `@Res()` and `stampCommitHeaders` to expose its commit. A handler that throws invalidates nothing. The interceptor resolves `LiveInvalidation` from the module that declares the controller before the handler runs, so a module that cannot reach `LiveModule` fails without committing the write. The tags callback's result type must match the handler's.

Add `LiveInspector`, provided and exported by `LiveModule`: `inspect(rooms)` returns the subscription and presence rows of the named rooms (there is no global room list), read where their subscriptions live. A runtime adapter reads a room through the new optional `LivePlatform.inspect(room)`; without it, the application's engine answers. On Cloudflare the Worker calls the room Durable Object's `inspectLive` RPC through the gateway binding its live driver delivers to. The `LiveInspection` type is unchanged. The Worker's live driver now validates the commit stamp a Durable Object returns before it reaches response headers.

`StudioLiveModule.forRoot({ rooms: ['default'] })` inspects those rooms through `LiveInspector`, so a Cloudflare application no longer builds a Studio source from `ENV` and Durable Object stubs. It fails at bootstrap without `LiveModule`. `forRoot({ source })` still takes a custom source; passing both is rejected.
