---
'@velajs/storage': patch
---

The storage controller's POST routes (`/sign-upload`, `/multipart/create`, `/multipart/sign-part`, `/multipart/complete`, `/multipart/abort`, `/delete` and `/sign-download`) declare `@HttpCode(200)`, so they keep answering and documenting 200 now that POST routes default to 201.
