---
"@velajs/client": minor
---

Keep offline snapshot preconditions valid when their originating subscription unmounts, while still detecting changes to an actively observed `undefined` value. Negotiate the reserved `$ping`/`$pong` heartbeat before recycling half-open live WebSockets, preserving compatibility with older servers, and allow heartbeat monitoring to be disabled with a non-positive interval.
