---
'@velajs/vela': patch
---

The default in-memory `ThrottlerStorage` keeps each key's counter until its own window (`ttl`) ends. It used to swap its maps every 60 seconds and drop a key untouched for one to two minutes, so a throttler with a longer window (`ttl: 600_000`, say) reset early and let a client exceed its limit. Ended windows are evicted. The store tracks at most `maxKeys` open windows (default 50,000; `storage: new ThrottlerStorage({ maxKeys })`, whose options type is `ThrottlerStorageOptions` from `@velajs/vela/throttler`). When every tracked window is still open, a request with a new key is refused with 429 until one expires, and the first refusal logs a warning: a live counter is never evicted.
