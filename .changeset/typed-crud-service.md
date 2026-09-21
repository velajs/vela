---
"@velajs/crud": minor
---

Add bindCrudService and the @velajs/crud/service entrypoint for schema-inferred
headless create/read/update/delete/list calls. Bindings verify the resource's
actual contracts, preserve the existing policy/tenant pipeline and keep input
transformations distinct from projected response types, status and pagination.
