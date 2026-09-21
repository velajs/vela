---
"@velajs/cloudflare": patch
---

Resolve queue and scheduled handlers and their pipeline components asynchronously
in the owning module's child scope. Seed execution context ownership, defer
handler construction until guards pass, track native waitUntil work through
provider disposal, and await every matching handler before returning failures.

Read validated WebSocket entrypoint metadata for upgrade routes so scoped gateways
do not require a bootstrap instance; retain legacy forwarding metadata scanning.
