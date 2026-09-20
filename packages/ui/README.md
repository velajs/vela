# @velajs/studio-ui

React UI for Vela Studio. Use `@velajs/studio-host` for local Worker development.
The standalone mount validates the host's protocol-v2 `window.__VELA_STUDIO__` connection.
The custom admin mount and UI router mount are independent.

API Explorer accepts path parameters, query parameters, request bodies and explicit API
headers (including API authorization/cookies). Execution is available only with a local
host connection, a registered `api.authorizeTryIt` operation and the Worker `opsEditable`
gate. Direct server embeds can browse OpenAPI but cannot execute HTTP through the Worker.

`studio.capabilities.operations` lists usable operations. Unsupported queue introspection
and live/presence enumeration are not advertised. Missing queue depths render as unknown,
not zero. Model `supports.bulkWrites` controls transaction-dependent bulk row actions;
read/single-row operations work with request-scoped adapters such as D1.

The `./client` subpath exports the fetch client; `./standalone` exports `mountStudio`.
Direct token login verifies an authenticated capability call before persisting the token.
Local host session credentials are never persisted.

The admin client validates all operation-specific RPC results and envelopes before
returning typed data. Malformed nested fields, operation mismatches and inconsistent
HTTP/error statuses produce `STUDIO_BAD_RESPONSE`.

## License

MIT
