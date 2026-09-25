---
'@velajs/vela': minor
---

The default in-memory `ThrottlerStorage` keeps each key's counter until its own window (`ttl`) ends. It used to swap its maps every 60 seconds and drop a key untouched for one to two minutes, so a throttler with a longer window (`ttl: 600_000`, say) reset early and let a client exceed its limit. Ended windows are evicted. The store tracks at most `maxKeys` open windows (default 50,000), configured per application with `storage: () => new ThrottlerStorage({ maxKeys })`; its options type is `ThrottlerStorageOptions` from `@velajs/vela/throttler`. A key is one route, throttler and client (`ThrottlerGuard` joins the controller, handler, throttler name and tracker), so size `maxKeys` as distinct clients per longest `ttl`, times the routes each one calls, times the throttlers (see docs/security.md).

**Behavior change:** when `maxKeys` windows are open, the default store answers 429 to a request with a new key until the earliest window ends, and the first refusal logs a warning; a live counter is never evicted, since that would reset its client's limit early. Previously the store never refused: it forgot counters instead. A client that already has a counter is counted as before. Raise `maxKeys` for the traffic of the longest window, keep in-memory windows short, or count long ones in a shared `ThrottlerStore`.
