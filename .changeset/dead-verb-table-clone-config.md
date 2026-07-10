---
"@velajs/crud": minor
---

Remove the dead `IMPLEMENTED_ENDPOINTS` export (stale since the extended-verb
registry landed — `resolveEnabledEndpoints` never read it; the live source of
implemented verbs is the kernel extended-verb registry) and promote
`clone.fieldsToReset` to a first-class, typed `clone?: { fieldsToReset?:
string[] }` on `CrudConfig` and `ResourceConfig` (previously read via an
untyped cast in the clone executor).
