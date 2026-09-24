---
'@velajs/crud': minor
---

Two `CrudModule.forFeature()` registrations that mount the same path with different definitions, such as the same resource with other `decorators` or `endpointDecorators`, now fail bootstrap with `CRUD path '/notes' is mounted by two different CrudModule.forFeature() features: 'note' (CrudNotesController) and ...`, whether they come from one registration or several. Paths compare in canonical form, so spellings that mount the same routes are one path: a trailing slash (`'/notes'` and `'/notes/'`) and other parameter names (`'/orgs/:org/notes'` and `'/orgs/:tenant/notes'`, reported as `'/orgs/:param/notes'`); the message names each feature's own spelling when it differs. Previously both controllers mounted and import order silently decided which policy served the path. Registering the identical `defineCrudFeature(...)` value from several modules is still allowed.

**Behavior change:** an application whose `CrudModule.forFeature()` registrations mount one path with different definitions no longer boots. Register one shared `defineCrudFeature(...)` value wherever the path is mounted, or give each feature its own path.
