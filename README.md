# @velajs/live-protocol

The normative wire protocol for **Vela live queries** — the single source of truth both the server (`@velajs/vela/live`) and the client (`@velajs/client`) implement against, so the two sides cannot drift.

Zero runtime dependencies. Ships three things:

1. **The frame catalog** — live frames ride Vela's WebSocket envelope under the reserved event `$live`, discriminated on `t`:
   - client → server: `sub`, `unsub`, `presence`
   - server → client: `ack`, `data`, `delta`, `settled`, `resume`, `error`
   - plus the `Vela-Commit-Cursor` / `Vela-Commit-Epoch` HTTP header names used to gate optimistic-update drops.
2. **The shared keyed-delta codec** — `encodeListDelta(previous, next)` / `applyListDelta(current, ops)` with identical bail-to-snapshot rules on both sides, and an exact-reconstruction guarantee: whenever the encoder does not bail, applying the ops reproduces `next` byte-for-byte, ordering included.
3. **Golden conformance fixtures** — `runProtocolConformance(codec)` runs byte-exact frame fixtures, pinned delta fixtures, and a seeded randomized sweep. The server and client test suites both call it; a wire change that forgets to update the fixtures fails a test instead of shipping an incompatibility.

## Versioning

`LIVE_PROTOCOL` is `2`. Every subscription must advertise `v: 2`; omitted or older versions are rejected. Receivers still ignore unknown frame types and unknown fields within the same version. Any wire change releases in lockstep: live-protocol → `@velajs/vela` → `@velajs/cloudflare` → `@velajs/client`.

## Delivery semantics (normative summary)

- **At-least-once** frames; keyed delta merge is idempotent, so replay after reconnect is harmless.
- **Cursor + epoch** identify a position in a *log scope* (one Durable Object on Cloudflare, one process on Node). Epoch mismatch ⇒ full snapshot, never a delta.
- **`settled`** means the re-run result was byte-identical: no payload, but the cursor still advances (this is what drops optimistic layers for writes that didn't change a query's result).
- **`resume`** means nothing relevant changed while the client was away: keep the cached value, advance the cursor.
- Optimistic updates gate on a subscription frame whose `cursor` passes the mutation's `Vela-Commit-Cursor` — never on HTTP response timing, which races the broadcast.

## Validation and limits

Both endpoints must run the exported frame guards before dispatch. They reject
non-JSON/prototype-bearing payloads, unsafe or negative cursors, incomplete
cursor/epoch pairs, unsupported advertised versions, oversized strings, and
malformed row operations. Defaults are 64 KiB per envelope, 1,000 delta operations,
and 4 KiB of presence metadata. Clients ignore regressive cursors and cold-resubscribe
when an epoch or watermark cannot continue safely.

See `vela/LIVE.md` in the main framework repo for the full feature documentation.
