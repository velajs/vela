---
'@velajs/crud': minor
---

`CrudModule.forFeature()`'s duplicate-path check also reads repeated slashes as one, so `'//notes'`, `'/notes//'` and `'/orgs//:org/notes/'` are the same path as `'/notes'` and `'/orgs/:org/notes'`. Case still distinguishes paths, since routing is case-sensitive (`'/Notes'` and `'/notes'` serve different requests).

**Behavior change:** two different features registered under spellings of one path, such as `'/notes'` and `'//notes'`, fail bootstrap, naming the path, where both used to mount and import order decided which one served. Mount each path once, or import one shared `defineCrudFeature(...)` definition wherever it is registered.
