---
"@velajs/vela": minor
---

Choose live keyed deltas only when their complete canonical UTF-8 envelope is smaller than a full snapshot, and reject complete envelopes above the shared 64 KiB limit before advancing subscription baselines. Add opt-in, pass-local `coalesceBy` sharing for equivalent high-fanout query reruns; authorization and delivery state remain isolated per subscriber, with count/byte ceilings bounding retained results. The shared WebSocket dispatcher also answers the framework-reserved `$ping` heartbeat across runtimes.
