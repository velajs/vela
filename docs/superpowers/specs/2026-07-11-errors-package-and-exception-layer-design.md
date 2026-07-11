# @velajs/errors + vela exception-handler layer — design

**Date:** 2026-07-11
**Status:** approved (brainstormed interactively; all four structural forks user-decided)
**Scope:** new sibling package `@velajs/errors` + vela-core integration (exception-handler layer, four edge wirings, two targeted fixes). Storage/crud/client convergence is explicitly follow-up work.
**Provenance:** clean-room port of concepts from Lunora's `@lunora/errors` + its plan 119, per the approved Lunora→Vela port matrix (`~/.claude/plans/check-lunora-have-alot-hidden-cosmos.md`; package analysis in `~/.claude/plans/lunora-port-audit-data.json`). Lunora is FSL-licensed: concepts and API design only, no code copying.

## Problem

Vela has five unrelated error families, three HTTP wire shapes, and no code concept in core:

| Class | Where | code | status | Wire shape |
|---|---|---|---|---|
| `HttpException` (+18) | vela `src/errors/http-exception.ts` | — | `statusCode` | `{statusCode,message}` or verbatim object |
| `WsException` | vela `src/websocket/ws-exception.ts` | — | — | `{event:'exception',data}` verbatim |
| `CrudException` (+7) | crud `envelope/errors.ts` | ✓ | ✓ | `{success:false,error:{code,message,details}}` |
| `StorageError` | storage `src/storage.error.ts` | ✓ | opt | `{error:{code,message}}` |
| `VelaLiveError` | client `src/errors.ts` | ✓ | opt | (client-side; parses all three shapes) |

Live security gaps (raw `err.message` to the browser): live engine initial-subscribe (`src/live/live.engine.ts:441`) and storage controller (`storage.controller.ts:70`, incl. wrapped provider text — storage fix is follow-up scope). Silent paths: a throwing exception filter is swallowed (`src/http/handler-executor.ts:131-133`); `diagnostics:'silent'` yields unlogged 500s; hono middleware errors bypass the filter tier entirely (no `app.onError`).

## Decisions (user-selected)

1. **Scope:** package + vela-core edges; sibling migrations are follow-up lockstep cycles.
2. **Wire contract:** canonical **error object** `{code, message, hint?, details?, docsUrl?}`. Default HTTP envelope `{error:{...}}`; crud may keep its `{success:false, error:{...}}` wrapper around the same object; live/WS frames carry the same fields in their own framing.
3. **Catalog model:** composable catalogs, explicit composition, **no globals**.
4. **Handler layer:** build the Laravel-style report/render layer in this cycle (closes the ROADMAP Phase-3 item), not just minimal seams.

## Part 1 — `@velajs/errors` (new repo `errors/`)

Repo modeled on `live-protocol`: MIT, ESM, `"sideEffects": false`, zero runtime deps, swc build + `tsc --emitDeclarationOnly`, vitest, golden fixtures. No `node:*` imports, no Buffer/process (edge rules).

### `VelaError`

```ts
class VelaError extends Error {
  readonly type = 'VelaError'; // brand — OWN ENUMERABLE data property
  code: string;                // machine-readable, snake_case
  status: number;
  hint?: string;
  docsUrl?: string;
  data?: unknown;              // structured details; client-safe iff the code is
}
```

- All fields own-enumerable so the error rides any wire codec / `structuredClone` / DO-RPC prop-copy with no special serialization path.
- Constructor overloads (typed): `new VelaError(code: CoreErrorCode, opts?)` — status/hint/docsUrl defaulted from the core catalog; `new VelaError(code: string, opts: { status: number; ... })` — open codes require explicit status. `opts` also carries `message?`, `hint?`, `data?`, `cause?`.
- `name = 'VelaError'`; prototype chain fixed for local `instanceof` (but nothing load-bearing may use `instanceof VelaError` — the guard is the contract).

### Catalog

```ts
type ErrorCatalogEntry = { status: number; title: string; hint?: string; docsUrl?: string; internal?: boolean };

defineErrorCatalog(entries)      // as-const-satisfies helper; keys derive the code union
  // → Catalog: { entries, error(code, opts?): VelaError }  (typed thrower bound to its defaults)
composeCatalogs(...catalogs)     // → Catalog; THROWS VelaError('internal') on duplicate code
```

Core catalog ships in the package: `bad_request` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404, `method_not_allowed` 405, `conflict` 409, `gone` 410, `payload_too_large` 413, `unsupported_media_type` 415, `unprocessable` 422, `too_many_requests` 429, `internal` 500 (`internal:true`), `not_implemented` 501, `bad_gateway` 502, `service_unavailable` 503, `gateway_timeout` 504. Entry data only — no behavior in the table. `STATUS_TO_CODE` export maps status→core code (used by the HTTP edge for code-less `HttpException`s).

### Guard (plan-119 lesson baked in from day one)

```ts
isVelaError(e): e is VelaErrorLike
// instanceof Error && typeof code === 'string' && typeof status === 'number' && type === 'VelaError'
```

Structural (survives DO↔worker RPC and wire-decoded twins where `instanceof` fails) **and branded** (a foreign driver error carrying `code`+`status` fails the brand — it cannot ride the echo path). `VelaErrorLike` is the structural type.

### `toErrorBody` — the single wire-redaction seam

```ts
toErrorBody(error: unknown, opts?: {
  catalog?: Catalog;             // composed; defaults to core
  fallbackStatus?: number;       // default 500
  redactedMessage?: (status) => string;
  encodeData?: (data) => unknown; // injectable wire codec hook
  includeHint?: boolean;          // default true
}) => { body: { error: WireErrorObject }, status: number, redacted: boolean }
```

Redaction rules, in order:
1. **Not a branded `VelaError`** → redact: `{code: statusToCode(fallbackStatus), message: generic}`, `redacted: true`.
2. **Branded, catalog entry has `internal: true`** (or code === `internal`) → redact (same shape, real status), `redacted: true`.
3. **Branded, any other code** (catalogued or open) → echo `message`/`hint`/`data→details`/`docsUrl`, `redacted: false`. Throwing a branded non-internal code is the author's vouch that the content is client-safe.

`redacted: true` is the caller's signal to log the raw error server-side. The seam never logs (zero-dep purity); observability is the caller's contract.

### Invariants

`invariant(cond, msg): asserts cond` and `unreachable(x: never): never` throw `VelaError('internal', ...)` — rich in server logs, redacted on the wire. Even "can't happen" bugs participate in the layer.

### Deliberately not ported

`MESSAGE_SOLUTIONS` message-matched hints (Lunora-codegen-specific), renderer/`flattenHint` (a future `@velajs/cli` renderer concern), `@visulima/error` shape mirroring (Vela picks its own renderer later).

## Part 2 — vela-core integration

vela core adds `@velajs/errors` as a runtime dependency (zero-dep leaf, same direction as `@velajs/live-protocol`).

### Exception-handler layer

```ts
interface ExceptionHandler {
  report?(error: unknown, ctx: ErrorReportContext): void | Promise<void>;
  dontReport?: Array<ErrorMatcher>;   // class ctor | code string | (e) => boolean
  context?(error: unknown, ctx): Record<string, unknown>; // merged into report payload
  render?(error: unknown, ctx: ExecutionContextLike): Response | ErrorBodyResult | undefined;
  // ErrorBodyResult = toErrorBody's return shape { body, status, redacted } — a Response ships as-is,
  // an ErrorBodyResult is serialized by the edge, undefined falls through to the default render.
}
```

- Provided via `APP_EXCEPTION_HANDLER` token (RouteManager `APP_*` convention, `useGlobalExceptionHandler()` sibling); default implementation always present.
- **Order at every edge:** ① `report()` first, always (unless `dontReport` matches) — including when a filter later claims the error; reporting and rendering are independent. ② Existing filter tier unchanged (closest-first, NestJS parity) as the render-override mechanism. ③ A throwing filter is itself reported and falls through to default render — fixes the swallow at `handler-executor.ts:131-133`. ④ Unclaimed → `handler.render()` → `undefined` → default render = `toErrorBody(error, { catalog: composed })`.
- Default reporter: structured `console.error` (method, path, handler, `context()` payload, raw error). `diagnostics: 'silent'` suppresses only the default reporter; a custom `report()` always runs. Sanctioned suppression is `dontReport`, never accidental.
- `report()` rejections/throws are contained (never mask the original error); async reports are not awaited on the hot path (fire-and-forget with contained failure). On Cloudflare the adapter may pass them through `waitUntil` when available (implementation detail, not contract).

### Catalog composition

`ERROR_CATALOG` multi-contribution token; modules contribute catalogs via `defineModule` contributions or `provideErrorCatalog(catalog)`; composed once at bootstrap via `composeCatalogs` (duplicate code → boot failure). The composed catalog is what the default render and every edge use.

### Edge wirings (all four + two fixes)

| Edge | Change |
|---|---|
| HTTP `HandlerExecutor` (`src/http/handler-executor.ts:125-153`) | Catch block rebuilt on the handler-layer order above. `HttpException` with **object** response → verbatim at its status (crud unbroken this cycle). String/bare `HttpException` → canonical `{error:{code,message}}` with code from `STATUS_TO_CODE`. Everything else → `toErrorBody`. **Break (sanctioned):** bare `{statusCode,message}` shape is gone. |
| hono `app.onError` (new, in `VelaFactory`) | Routed into the same report+render pipeline; hono middleware / hono `HTTPException` errors can no longer bypass redaction or logging. |
| WebSocket (`ws-exception.ts:19-25`, `ws-dispatcher.ts:323-347`) | `toErrorFrame` rebuilt over `toErrorBody`: `WsException` payload verbatim (developer-controlled WS analog of `HttpException`); branded `VelaError` → canonical object in `data`; unknown → redacted. Filter-throw path reports before falling back. |
| Live engine (`src/live/live.engine.ts:441`, `:287`) | Execution errors: redacted unless branded (raw error → `report()` only). Subscribe **parse** errors keep echoing the validation message (client-facing by convention, same as crud's `fromZodError`). Frame code mapping: validation→`bad_args`, forbidden→`forbidden`, else `internal`. `LIVE_ERROR_CODES` stays normative in `@velajs/live-protocol`; the code spaces do not merge. |
| Queue/scheduled (`queue.dispatch.ts:160-168`, `queue.binding.ts:58-69`, `schedule.executor.ts:74-80`) | `report()` before the unclaimed rethrow — platform retry semantics untouched. Inline driver `routeError` default becomes the reporter instead of bare `console.error`. |

## Testing

**errors repo:** unit tests per export; the plan-119 regression — `Object.assign(new Error('internal driver detail: host=10.0.0.5'), {code:'PROTOCOL_ERROR', status:502})` must return `redacted:true` and never echo; brand round-trip via `JSON.parse(JSON.stringify(...))` and `structuredClone`; `composeCatalogs` duplicate detection; typed tests dogfooding the exported signatures (no `as never`; typecheck covers `*.test.ts`); golden fixtures pinning `WireErrorObject`.

**vela core:** report-always-runs (incl. filter-claimed path); throwing-filter regression (no longer silent); hono middleware error → canonical body via `app.request()` e2e; live redaction (unbranded resolver error → generic frame message, raw text only in report); queue report-then-rethrow; workers vitest config exercising brand survival across the DO-hibernation codec.

## Out of scope (follow-up lockstep cycles)

Storage controller convergence + its raw-message leak fix; crud nesting the canonical object; client `toMutationError` simplification to one shape; CLI renderer + OpenAPI error-response schemas from the catalog; the row of `stratal`'s parallel `HttpException` (different framework, noted as drift only).

## Release

`@velajs/errors` 1.0.0 (new repo, MIT). vela core minor bump with the sanctioned wire-shape break (1.x break-freely policy). No deprecation shims.
