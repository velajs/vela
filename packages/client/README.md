# @velajs/client

Framework-neutral HTTP and live-query client for Vela applications.

```sh
npm install @velajs/client
```

Use `@velajs/client/http` for the upstream Hono HTTP client and shared endpoint
contracts. The main entrypoint provides live subscriptions, reconnects and
optimistic updates; optional subpaths expose presence and offline support.

For generated form contracts, pass
`fetch: withFormEncoding(formEncodings, suppliedFetch)` to `hc`. This opt-in
adapter preserves multipart boundaries and serializes URL-encoded routes as
declared, including repeated fields. It accepts browser/native fetch transports
without platform dependencies; wrap per-call fetch overrides too.

See the [client guide](https://github.com/velajs/vela/blob/main/docs/client/README.md),
[HTTP guide](https://github.com/velajs/vela/blob/main/docs/client/HTTP.md), and
[complete Workers starter](https://github.com/velajs/vela/tree/main/apps/api-starter).
