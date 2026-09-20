# @velajs/studio-protocol

Shared wire types, constants and boundary validators for Studio host, server and UI.

Protocol v2 introduces `StudioConnection`, validated with `parseStudioConnection`, and
`StudioCapabilities.operations`. `api.authorizeTryIt` replaces in-process `api.tryit`:
it authorizes the local host to execute actual Worker HTTP. `TryItRequest` and
`TryItResponse` are validated at the host/browser boundary. Model descriptors include
`supports.bulkWrites` for adapters with transaction support.

`parseStudioResponse(op, value)` validates every result against the operation's
concrete Zod schema. `parseStudioRpcResponse(op, value)` also checks the envelope,
operation identity, metadata and error fields. The browser client uses these
parsers before exposing typed results; callers cannot choose an arbitrary result
type. Dynamic model rows and OpenAPI documents retain their declared unknown data.

Upgrade host, server and UI together. There is no protocol-v1 compatibility path.

## License

MIT
