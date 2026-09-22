---
'@velajs/vela': minor
---

Accept a schema wherever `@Body`, `@Query`, `@Param`, `@Headers` and `@Cookie` accept a
pipe: `@Body(schema)`, `@Query(schema)`, `@Query('page', schema)`, `@Param('id', schema)`,
`@Headers('x-tenant', schema)` and `@Cookie('theme', schema)`. The schema can be a Zod or
other Standard Schema, a `parse()` parser, or a `defineDto` descriptor. The decorator
validates the value with `new ValidationPipe(schema)`, so invalid input is a 400 with the
normalized issues, OpenAPI documents the schema, and pipes written after it receive the
parsed output. The new `SchemaParamDecorator` type describes these overloads.

**Behavior change:** a Zod schema passed to a parameter decorator used to be run as a pipe
through its own `transform()` method, so the handler silently received a new schema object
instead of validated data. It now validates the value and rejects invalid input with a 400.
A Standard Schema or parser object without `transform()` used to fail with a 500 and is now
accepted. Pipe classes and objects with a `transform()` method are still run as pipes.
