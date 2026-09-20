---
'@velajs/vela': major
---

Require LiveModule driver and cursor-log options to be factories that create a fresh resource per application. Factories may return promises and can capture injected configuration from forRootAsync. Remove perAppLiveDriver and its shared platform environment forwarding, so a Worker and its Durable Objects cannot overwrite each other's driver state through a shared module configuration.

Require @LiveQuery(name, definition, options) to declare shared args/result parsers. The decorator checks handler input and output types; runtime bound callbacks preserve parsed input through tags, coalescing, and invocation, and final interceptor output is validated before caching or delivery. Restore reconstructs data-only subscription records, validates identity expiry, reparses original inputs, recomputes tags, and discards volatile result baselines.
