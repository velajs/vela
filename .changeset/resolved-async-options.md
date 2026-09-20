---
'@velajs/authz': patch
---

Build AuthzModule authorization from resolved options for both forRoot and forRootAsync. Async factories now apply their configured roles, permission declarations, and resolvers instead of creating an empty authorization engine.
