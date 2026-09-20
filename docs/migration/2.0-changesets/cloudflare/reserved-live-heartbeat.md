---
"@velajs/cloudflare": patch
---

Move the hibernating WebSocket auto-response pair to Vela's reserved `$ping`/`$pong` heartbeat so live-client liveness checks stay asleep inside Durable Objects. Raise the Vela peer floor to 1.22.0 so transports without auto-response support still inherit the dispatcher fallback.
