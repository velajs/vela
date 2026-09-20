---
'@velajs/vela': major
---

Require custom parameter decorator data whenever the factory's data type excludes undefined. Ordinary custom decorators retain parameter pipes and run after guards.

Replace lazy parameter proxies with explicit memoized functions. Handlers call the injected function to obtain the actual value or Promise. Successful values, rejected promises, and synchronous thrown values are retained without retrying the factory. Lazy decorators no longer accept parameter pipes; validate produced values inside the factory.
