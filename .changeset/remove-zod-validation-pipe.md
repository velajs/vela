---
'@velajs/vela': minor
---

Remove `ZodValidationPipe`. It called `schema.parse()` directly, so invalid input
escaped as a raw validator error and was answered with a 500 instead of a 400.

**Behavior change:** `ZodValidationPipe` is no longer exported. Replace
`new ZodValidationPipe(schema)` with `new ValidationPipe(schema)`, which accepts a Zod or
other Standard Schema, a `parse()` parser, or a `defineDto` descriptor. Invalid input now
receives a 400 whose body carries `message: 'Validation failed'` and the normalized
`errors`; an exception thrown by a validator itself is still a server error.
