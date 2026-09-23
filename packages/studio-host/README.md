# @velajs/studio-host

Local Node host for Vela Studio. It serves the prebuilt UI and connects to a running
Worker over HTTP, including Wrangler development servers.

```ts
import { startStudioServer } from '@velajs/studio-host';

const studio = await startStudioServer({
  workerOrigin: 'http://127.0.0.1:8787',
  adminToken: process.env.VELA_STUDIO_TOKEN,
  adminPath: '/_vela/admin', // actual Worker mount, including any global prefix
  basePath: '/studio',      // independent browser UI mount
});
console.log(studio.url);
```

The CLI uses the same host: `vela studio --url http://127.0.0.1:8787 --token "$TOKEN"`.
The Worker must import `StudioModule.forRoot({ rootModule, editable: { ops: true } })`
for OpenAPI browsing and API execution; Studio reads its `VELA_STUDIO_TOKEN` secret from
the Worker's `ENV` (or pass `token`). Other write categories remain separately controlled
by the Worker. The host has no `editable` option; read-only sessions bootstrap normally.

The host emits a protocol-v2 `StudioConnection` as `window.__VELA_STUDIO__`. It contains
the browser session credential, admin mount, UI mount and local API request endpoint.
Reload Studio after restarting the host. The master token stays in the host process;
the browser session is required for every proxied admin request and is not persisted.

API Explorer sends its request to `{adminPath}/api-request`. The host asks the Worker
`api.authorizeTryIt` operation to authorize and audit the method/path, then makes a
separate HTTP request to the configured Worker origin. This enters the real Worker
with native bindings and execution context. Only API headers explicitly entered in the
explorer are sent. Browser cookies, browser session credentials and the master token
are isolated; response cookies are displayed as data and are never installed in the
browser. Redirects are returned for inspection rather than followed. Absolute URLs and
requests to the configured admin mount are rejected.

Install and build `@velajs/studio-ui` before starting the host. Host tests include a
real Miniflare/Workerd HTTP integration test with KV and `waitUntil`.

## License

MIT
