# @velajs/client

Framework-neutral HTTP and live-query client for Vela applications.

```sh
npm install @velajs/client
```

Use `@velajs/client/http` for the upstream Hono HTTP client and shared endpoint
contracts. The main entrypoint provides live subscriptions, reconnects and
optimistic updates; optional subpaths expose presence and offline support.

See the [client guide](https://github.com/velajs/vela/blob/main/docs/client/README.md),
[HTTP guide](https://github.com/velajs/vela/blob/main/docs/client/HTTP.md), and
[complete Workers starter](https://github.com/velajs/vela/tree/main/apps/api-starter).
