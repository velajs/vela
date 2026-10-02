---
"@velajs/vela": minor
---

Serve OpenAPI documents and optional Scalar, Swagger UI or ReDoc pages through the normal controller pipeline. Documentation routes now follow the global prefix and run global guards, middleware, interceptors and filters. Configure controller decorators for access policy, and UI options for pinned assets, language and response headers.

Export OpenApiService for custom controllers with mount disabled, and support transformDocument for both offline and served generation. Read application prefix exclusions and URI versioning automatically. Move path and other structural options alongside forRootAsync factories. See the framework upgrade guide for migration steps.
