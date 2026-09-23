---
"@velajs/cloudflare": patch
---

A Durable Object WebSocket whose `handleConnection` hook broadcasts to its room, for example `server.emit('system', { text: 'joined' })`, is now admitted. The broadcast reached the still-pending socket and rejected it, so every such upgrade failed with "Unable to persist authorized WebSocket state". Broadcasts now skip a socket while its connection hook runs and deliver to the room's active sockets; a pending socket that is not being admitted is still closed with 1008. When a socket is rejected while its hook runs, the error now says so.
