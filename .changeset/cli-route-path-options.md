---
'@velajs/cli': patch
---

`vela openapi dump`, `vela client generate` and the `vela mcp serve` OpenAPI tool and resource build their documents with the application's `app.getRoutePathOptions()`, so the documented paths match the served routes, including routes a global prefix's `exclude` serves unprefixed, `VERSION_NEUTRAL` routes and a custom versioning `prefix`.
