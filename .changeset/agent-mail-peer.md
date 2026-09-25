---
'@velajs/agent': patch
---

The optional `@velajs/mail` peer range moves to `^1.32.0`, the mail release published with this version. The agent's behavior is unchanged, and it works with mail 1.31 as 1.28.2 does: as for `@velajs/storage` 1.31.1, a patch release may raise a peer floor to the release it ships with. With mail 1.31, keep `@velajs/agent` 1.28.2: a package manager reports a peer conflict for 1.28.3.
