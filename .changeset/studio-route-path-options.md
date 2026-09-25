---
'@velajs/studio': minor
---

Studio's OpenAPI view builds its document with the application's route-path options (`app.getRoutePathOptions()`), so its paths match the served routes, including routes a global prefix's `exclude` serves unprefixed, `VERSION_NEUTRAL` routes and a custom versioning `prefix`.

**Behavior change:** `StudioAppHolder.capture(app, routePathOptions)` takes the application's `RoutePathOptions` instead of the global prefix string, and the new `routePathOptions` getter returns them; `globalPrefix` still returns the prefix.
