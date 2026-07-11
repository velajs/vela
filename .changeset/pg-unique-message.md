---
"@velajs/crud-drizzle": patch
---

Recognize Postgres's "duplicate key value violates unique constraint" message
shape in the unique-violation → 409 translation (previously only the `23505`
code matched), and exercise the pg dialect end to end via a new PGlite test
leg (predicates, cursor, restore, nested driver, real-transaction rollback).
