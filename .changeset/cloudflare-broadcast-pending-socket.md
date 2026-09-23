---
"@velajs/cloudflare": patch
---

A room broadcast from `handleConnection` no longer closes the connecting socket. A Durable Object socket is still being admitted while its connection hook runs, and local delivery used to treat it like an expired or rejected socket: it marked it rejected and closed it with 1008, so a gateway that announced each new client with `server.emit(...)` rejected every upgrade. Broadcasts now skip a socket until its admission completes. Admitted members still receive the frame, and expired or rejected sockets are still closed.
