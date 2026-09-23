---
'@velajs/crud': minor
---

Declare the 201 that generated `create` routes answer with `@HttpCode(201)`, so the
OpenAPI walk documents only the 201 and 400 responses they return.

**Behavior change:** OpenAPI documents and generated clients no longer list a default
`200` response beside the `201` of a generated `create` operation; code that narrowed a
generated client's create result on `status === 200` must use `201`. An `@Override`'d
create handler keeps its own status: declare `@HttpCode(201)` on it to document the same
contract.
