---
"@velajs/live-protocol": patch
---

Keep every exactly reconstructable keyed-list delta available to delivery layers instead of discarding candidates through an operation-count heuristic. Servers can now compare complete canonical delta and snapshot envelopes by their actual encoded cost, and the encoder enforces the shared 64 KiB limit on that complete wire envelope.
