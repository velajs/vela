---
'@velajs/storage': minor
---

The storage controller's POST routes (`/sign-upload`, `/multipart/create`, `/multipart/sign-part`, `/multipart/complete`, `/multipart/abort`, `/delete` and `/sign-download`) declare `@HttpCode(200)`, so OpenAPI and `vela client generate` keep documenting 200 now that POST routes default to 201. They already answered 200, since their handlers return their own `c.json()` responses. **Behavior change:** the `@velajs/vela` peer range becomes `^1.32.0`, the core this release ships with, so this is a minor release even though the routes behave as before: a release that raises a peer floor never ships as a patch that an existing range would install. With core 1.31, keep `@velajs/storage` 1.31.0, which already sent and documented these routes as 200.
