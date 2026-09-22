---
'@velajs/vela': minor
---

Add optional Web API tracing and metrics with no-op defaults, validated W3C trace
propagation, explicit request-scope context, and an OpenTelemetry bridge that uses
application-owned tracers and meters without exporter dependencies or automatic
network activity. HTTP instrumentation records one completion through streaming,
cancellation, deferred work, and disposal using bounded default attributes.
Structural HTTP client and execution observers support independent integrations.
