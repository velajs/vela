---
"@velajs/vela": minor
"@velajs/cloudflare": minor
"@velajs/live-protocol": minor
"@velajs/client": minor
---

Validate WebSocket correlation envelopes and hibernation attachments, preserve live baselines after refused sends, and add bounded connection-local send admission and incoming work. Existing void send APIs and unversioned 1.x attachments remain supported.

Drop frames still waiting on Node connection setup after overload or close. Use browser-valid private close codes and reconnect after client-side send admission failures.
