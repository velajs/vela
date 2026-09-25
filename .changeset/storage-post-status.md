---
'@velajs/storage': patch
---

The storage controller's POST routes (`/sign-upload`, `/multipart/create`, `/multipart/sign-part`, `/multipart/complete`, `/multipart/abort`, `/delete` and `/sign-download`) declare `@HttpCode(200)`, so OpenAPI and `vela client generate` keep documenting 200 now that POST routes default to 201. They already answered 200, since their handlers return their own `c.json()` responses. This release requires `@velajs/vela` 1.32.0: its peer range becomes `^1.32.0`.
