---
'@velajs/crud': patch
---

`CrudModule.forFeature()`'s duplicate-path check also reads repeated slashes as one, so `'//notes'`, `'/notes//'` and `'/orgs//:org/notes/'` are the same path as `'/notes'` and `'/orgs/:org/notes'`: two different features registered under such spellings fail bootstrap instead of both mounting. Case still distinguishes paths, since routing is case-sensitive (`'/Notes'` and `'/notes'` serve different requests).
