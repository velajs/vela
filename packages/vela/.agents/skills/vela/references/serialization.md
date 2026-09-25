# Response serialization

A route's `response` schema shapes what it sends: `@Get({ response: PublicUser })`
parses the handler's final result (after interceptors) through the schema, so a
stripping object schema removes fields such as a stored password, and
`@CacheResponse` stores the response the route sent, never the stripped fields, and replays it on a hit without parsing again, so change the cache `namespace` after tightening `response`. The whole
result is parsed: use `z.array(item)` for arrays and a schema for envelopes.
Standard Schema, `parse`/`parseAsync` parsers and `defineDto` descriptors work;
async refinements and transforms run once (`parseAsync` first). A result the
schema rejects is a server error (redacted 500, reported with its issues). The
same schema documents OpenAPI and types the generated client, and the handler's
return type must match it. There is no `@Serialize` or `SerializerInterceptor`.

`defineSerializer({ input, output, project })` composes domain validation,
projection and wire validation. `project` receives `SchemaOutput<typeof input>`
and returns `SchemaInput<typeof output>` or a promise. The descriptor's
`serialize(SchemaInput<typeof input>)` and `parse(unknown)` both return a promise of the output
schema's transformed value. A serializer is a Standard Schema from the domain
input to the wire output, so `@Get('/:id', { response: accountSerializer })`
lets the handler return the domain value while the route sends the projection;
OpenAPI documents `.output`, the original output schema.

Validate a private-state class with a schema such as `z.instanceof(Account)` and
project through public methods. There is no reflective hydration, graph traversal,
private-field enumeration or custom JSON encoding. Choose JSON-compatible output
values. The descriptor is frozen and stateless; use ordinary scoped providers for
service-dependent projections.

See the repository's `docs/serialization.md` for the runnable authoring pattern.
