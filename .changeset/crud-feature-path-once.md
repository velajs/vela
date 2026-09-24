---
'@velajs/crud': patch
---

Two `CrudModule.forFeature()` registrations that mount the same path with different definitions, such as the same resource with other `decorators` or `endpointDecorators`, now fail bootstrap with `CRUD path '/notes' is mounted by two different CrudModule.forFeature() features: 'note' (CrudNotesController) and ...`, whether they come from one registration or several. Previously both controllers mounted and import order silently decided which policy served the path. Registering the identical `defineCrudFeature(...)` value from several modules is still allowed.
