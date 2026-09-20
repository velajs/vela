# @velajs/errors

Unified error layer for Vela: a single branded `VelaError` whose every field is an own-enumerable property (so it rides any wire codec, `structuredClone`, or Durable Object RPC prop-copy unchanged), composable error catalogs that default status/hint/docs from a code, and the one `toErrorBody` seam that redacts internal errors before they reach the wire. Zero runtime dependencies, edge-runtime safe.

## Why

Across HTTP, WebSocket, live queries, and queue reporting, Vela needs one answer to two questions: *"is this error safe to show a client?"* and *"what exact JSON goes on the wire?"* This package is that answer. Every transport edge funnels through `toErrorBody`, so the redaction invariant holds identically everywhere and the wire shape is pinned by a golden fixture.

## The three redaction rules

`toErrorBody(error, options?)` returns `{ body, status, redacted }`. Whether the original message/hint/details reach the client is decided by exactly these rules:

| # | Input error | Result | `redacted` |
| - | ----------- | ------ | ---------- |
| 1 | Anything not a branded `VelaError` (plain `Error`, a foreign driver error that merely has `code`+`status`, `null`, …) | Generic title for the fallback status; original message dropped | `true` |
| 2 | A branded `VelaError` whose code is the literal `internal`, **or** whose catalog entry has `internal: true` | `code` + `status` kept; message/hint/details dropped, replaced with the generic title for that status | `true` |
| 3 | Any other branded `VelaError` — catalogued or open (unknown) code | `code`, `message`, and any `hint`/`docsUrl`/`details` echoed verbatim | `false` |

Status alone never triggers redaction: an open code with `status: 500` still echoes (rule 3) — only the literal `internal` code or an `internal: true` catalog flag redacts (rule 2). `redacted: true` is the caller's signal to log the raw error server-side; `toErrorBody` itself never logs.

The canonical wire shape (pinned by `wire-fixture.test.ts`) is:

```json
{ "error": { "code": "not_found", "message": "no such route", "hint": "Run `vela route list`." } }
```

and, redacted:

```json
{ "error": { "code": "internal", "message": "Internal Server Error" } }
```

## The brand contract

`isVelaError` is a **branded structural** guard: it requires `error instanceof Error` plus `typeof code === 'string'`, `typeof status === 'number'`, and `type === 'VelaError'`. The `type` brand is an own-enumerable property, so it survives JSON round-trips, `structuredClone`, and DO↔worker RPC prop-copy — a wire-decoded twin (`Object.assign(new Error(msg), {...decoded})`) still passes. `instanceof VelaError` is deliberately **not** load-bearing (it breaks across realms and on decoded twins), so nothing in the redaction path uses it.

The consequence for new transport edges: **construct real `VelaError`s, not shape-alikes.** A foreign error that merely carries `code` and `status` is intentionally rejected by the guard and redacted by rule 1 — that is the mechanism that stops a database driver's `internal driver detail: host=10.0.0.5` from riding the client-echo path.

## Catalog composition

A catalog maps codes to defaults (`status`, `title`, optional `hint`/`docsUrl`, and the `internal` redaction posture). `CORE_CATALOG` ships the standard HTTP-shaped codes. Compose your app's catalog onto it; duplicate codes throw at composition time.

```ts
import { CORE_CATALOG, composeCatalogs, defineErrorCatalog } from '@velajs/errors';

const appCatalog = composeCatalogs(
  CORE_CATALOG,
  defineErrorCatalog({
    order_expired: { status: 410, title: 'Order expired', hint: 'Create a new order.' },
    db_corruption: { status: 500, title: 'Storage failure', internal: true },
  }),
);
```

> **Gotcha:** a custom catalog's `title` is **not** used as the thrown error's default message. Only core codes default their message to the catalog title; a throw for a custom-catalog code defaults its message to the code string unless you pass `message`. Pass `message` explicitly when you want human-readable text (and remember rule 2 will redact it anyway for `internal: true` entries). Use `catalog.error(code, options)` to inherit the entry's `status`/`hint`/`docsUrl`.

## Usage

```ts
import { invariant, toErrorBody, VelaError } from '@velajs/errors';

// Throw a catalogued error; status/hint default from the core catalog.
throw new VelaError('not_found', { message: 'no such route', hint: 'Run `vela route list`.' });

// Internal-coded errors are rich in logs, redacted on the wire.
invariant(subscription !== undefined, 'subscription registry out of sync', { subId });

// At every transport edge, funnel through the one seam:
const { body, status, redacted } = toErrorBody(caughtError, { catalog: appCatalog });
if (redacted) logger.error(caughtError); // safe details stay server-side
return Response.json(body, { status });
```

`invariant(condition, message, data?)` narrows types (`asserts condition`) and, on failure, throws an `internal`-coded `VelaError` — always redacted by rule 2. `unreachable(value: never)` is its exhaustiveness-check companion.

## Error fingerprinting (`@velajs/errors/fingerprint`)

A separate, tree-shakeable subpath that turns noisy repeats of the same error into one stable **issue** identity. It is zero-dependency and computes identically in the browser, the workerd runtime, and Node, so a live in-flight error and one recomputed later from a persisted log row collapse onto the same fingerprint.

```ts
import { fingerprintError, bucketMessage, FINGERPRINT_VERSION } from '@velajs/errors/fingerprint';

// 16-hex-char stable grouping id over functionPath :: bucket(message).
fingerprintError({ functionPath: 'orders:get', message: 'order 550e8400-… not found' });

// The `code` is metadata and is NEVER hashed — the redacted wire view (whose
// code toErrorBody may rewrite or drop) and the raw server-side error group
// together. It also works straight off toErrorBody's output:
const { body } = toErrorBody(err);
fingerprintError({ functionPath, message: body.error.message, code: body.error.code });
```

- **`fingerprintError({ functionPath, message, code? }): string`** — the stable 16-hex grouping hash. `code` is display metadata only and is never folded into the hash.
- **`bucketMessage(message): string`** — the exported normalizer. Strips per-occurrence noise (URLs, request/filesystem paths, UUIDs, IPs, long numeric/hex ids, timestamps, emails) so a route-scanner sweep of 404s with varying paths folds to a single fingerprint. Input is clamped (~1 KB) before any regex runs as a ReDoS guard.
- **`FINGERPRINT_VERSION`** — bump whenever the bucketer heuristics change; changed heuristics re-partition history, so consumers that persist fingerprints store this alongside each hash to know when a recompute is due.
- **`sha256Hex(input): string`** — the internal portable synchronous SHA-256 (no `node:crypto`, no async `crypto.subtle`), also exported. **Content-addressing / grouping only — never a security or MAC primitive.**

> The message-normalization / grouping approach is inspired by [`@superlog/fingerprint`](https://github.com/superloglabs/superlog) (Apache-2.0). This is an independent, clean-room implementation.

## API

- `VelaError`, `VelaErrorOptions` — the one error and its constructor options.
- `isVelaError`, `VelaErrorLike` — the branded structural guard and its type.
- `toErrorBody`, `WireErrorObject`, `ErrorBodyResult`, `ToErrorBodyOptions` — the single wire-redaction seam.
- `defineErrorCatalog`, `composeCatalogs`, `Catalog`, `ErrorCatalogEntry` — catalog authoring.
- `CORE_CATALOG`, `CORE_ENTRIES`, `CoreErrorCode`, `STATUS_TO_CODE` — the core catalog and its lookups.
- `invariant`, `unreachable` — internal-coded assertion helpers.
- `@velajs/errors/fingerprint`: `fingerprintError`, `ErrorFingerprintInput`, `bucketMessage`, `FINGERPRINT_VERSION`, `sha256Hex` — the error-grouping subpath.
