---
'@velajs/cli': patch
---

Dispose applications after seeder registry or command failures, preserving the
primary result when cleanup fails. Share command lifetime handling across
introspection, client generation and MCP, including cleanup of older 1.x apps
whose shutdown hooks throw.
