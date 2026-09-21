# Response serialization

`@Serialize({ schema })` requires `SerializerInterceptor` (scoped or global).
The shared async schema boundary supports Standard Schema DTOs and legacy
parse/parseAsync parsers. Every scalar/item result is awaited. Arrays retain the
1.x element-by-element behavior; whole-array/envelope schemas belong in explicit
endpoint contracts. Output validation errors are server errors. Missing metadata
passes through; malformed metadata fails closed.

`defineSerializer({ input, output, project })` composes domain validation,
projection and wire validation. `project` receives `SchemaOutput<typeof input>`
and returns `SchemaInput<typeof output>` or a promise. The descriptor's
`serialize(SchemaInput<typeof input>)` and `parse(unknown)` both return a promise of the output
schema's transformed value. `.schema` contains the full pipeline for `@Serialize`;
`.output` exposes the original output schema for explicit documentation.

Validate a private-state class with a schema such as `z.instanceof(Account)` and
project through public methods. There is no reflective hydration, graph traversal,
private-field enumeration or custom JSON encoding. Choose JSON-compatible output
values. The descriptor is frozen and stateless; use ordinary scoped providers for
service-dependent projections. `@Serialize` does not add OpenAPI response metadata
or constrain the decorated method's TypeScript return type. Use endpoint contracts
when validation must occur after every interceptor.

See the repository's `docs/serialization.md` for the runnable authoring pattern.
