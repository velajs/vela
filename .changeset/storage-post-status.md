---
'@velajs/storage': patch
---

The storage controller's POST routes (`/sign-upload`, `/multipart/create`, `/multipart/sign-part`, `/multipart/complete`, `/multipart/abort`, `/delete` and `/sign-download`) declare `@HttpCode(200)`, so OpenAPI and `vela client generate` keep documenting 200 now that POST routes default to 201. They already answered 200, since their handlers return their own `c.json()` responses. The `@velajs/vela` peer range becomes `^1.32.0`, the core this release ships with. On core 1.31, which already sent and documented these routes as 200, that range is its only change, so it is a patch: a patch release may raise a peer floor to the release it ships with, while a release that would not work on its predecessor's core, such as `@velajs/testing` 1.32.0, is a minor. With core 1.31, keep `@velajs/storage` 1.31.0: a package manager reports a peer conflict for 1.31.1.
