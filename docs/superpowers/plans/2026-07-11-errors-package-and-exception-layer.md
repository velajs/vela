# @velajs/errors + Exception-Handler Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the zero-dep `@velajs/errors` package (branded `VelaError`, composable catalogs, the `toErrorBody` redaction seam) and wire it through vela core via a Laravel-style exception-handler layer, closing the live-engine leak, the swallowed-filter path, and the hono `onError` bypass.

**Architecture:** Phase A builds the standalone `errors/` repo (new sibling, modeled on `live-protocol/`). Phase B integrates it into `vela/`: an `ErrorsModule` (defineModule) providing `APP_EXCEPTION_HANDLER` + composed `ERROR_CATALOG`, then rewires four edges (HTTP HandlerExecutor, hono onError, WS toErrorFrame, live engine, queue dispatch) onto report-first ordering + `toErrorBody` rendering.

**Tech Stack:** TypeScript ESM, swc + `tsc --emitDeclarationOnly`, vitest. Zero runtime deps in `errors/`. Spec: `docs/superpowers/specs/2026-07-11-errors-package-and-exception-layer-design.md` (read it first).

## Global Constraints

- Edge-runtime rules (vela CLAUDE.md): no `node:*` imports, no `Buffer`/`process`, no `setInterval`.
- Clean-room: concepts from Lunora only — NEVER copy code from `lunora/` (FSL license). Do not open `lunora/packages/errors/src` while implementing.
- Exports: named exports only; no default+named mixing. No `.js` extensions in relative imports (vela repo convention differs from errors repo — errors repo also uses extensionless, `moduleResolution: bundler` via mirrored live-protocol tsconfig).
- Tests dogfood exported type signatures — no `as never` / `as any` casts to force fits; if a signature fights the test, fix the signature (user rule).
- Wire contract (canonical error object): `{ code, message, hint?, details?, docsUrl? }` nested under `error` for HTTP.
- Redaction invariant: a non-branded error's `.message` must NEVER appear in any client-bound body/frame.
- Commit style: conventional commits (`feat(errors): …`, `feat(exceptions): …`, `fix(live): …`).
- `errors/` repo: MIT, `"sideEffects": false`, `engines.node >=20`, version `1.0.0`.

---

## Phase A — the `errors/` repo

### Task 1: Scaffold repo + `VelaError`

**Files:**
- Create: `/Users/kauan/Projects/velajs/errors/package.json`, `tsconfig.json`, `.swcrc` (mirror `/Users/kauan/Projects/velajs/live-protocol/` configs verbatim, then adjust name/description), `LICENSE` (MIT, copy from live-protocol, same author), `README.md` (one-paragraph stub), `vitest.config.ts` (mirror live-protocol)
- Create: `/Users/kauan/Projects/velajs/errors/src/error.ts`
- Test: `/Users/kauan/Projects/velajs/errors/src/__tests__/error.test.ts`

**Interfaces:**
- Produces: `class VelaError extends Error` with own-enumerable `type/code/status/hint/docsUrl/data`; `interface VelaErrorOptions { message?, status?, hint?, docsUrl?, data?, cause? }`. Task 2's catalog `error()` and Task 4's `toErrorBody` construct/consume these exact fields.

- [ ] **Step 1: Scaffold.** `mkdir /Users/kauan/Projects/velajs/errors && cd $_ && git init -b main`. Copy `tsconfig.json`, `.swcrc` (if present), `vitest.config.ts`, `LICENSE` from `../live-protocol/`. Write `package.json` mirroring live-protocol's exactly (same scripts/devDeps/exports map) with: name `@velajs/errors`, version `1.0.0`, description `Unified error layer for Vela: branded VelaError, composable error catalogs, and the single toErrorBody wire-redaction seam`, repository url `git+https://github.com/velajs/errors.git`, keywords `["vela","errors","error-catalog","redaction","framework"]`. Run `pnpm install`.

- [ ] **Step 2: Write the failing test** (`src/__tests__/error.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { VelaError } from '../error';

describe('VelaError', () => {
  it('defaults status/hint from the core catalog for core codes', () => {
    const err = new VelaError('not_found');
    expect(err.status).toBe(404);
    expect(err.code).toBe('not_found');
    expect(err.message).toBeTruthy();
  });

  it('accepts open codes with explicit status', () => {
    const err = new VelaError('order_expired', { status: 410, message: 'Order expired' });
    expect(err.status).toBe(410);
    expect(err.code).toBe('order_expired');
  });

  it('carries every field as an OWN ENUMERABLE property (wire-codec contract)', () => {
    const err = new VelaError('conflict', { hint: 'Retry with the latest revision.', data: { id: 1 } });
    const keys = Object.keys(err);
    for (const k of ['type', 'code', 'status', 'hint', 'data']) expect(keys).toContain(k);
    const twin = JSON.parse(JSON.stringify({ ...err }));
    expect(twin.type).toBe('VelaError');
    expect(twin.code).toBe('conflict');
    expect(twin.status).toBe(409);
  });

  it('supports cause', () => {
    const cause = new Error('db down');
    const err = new VelaError('internal', { cause });
    expect(err.cause).toBe(cause);
  });
});
```

- [ ] **Step 3: Run to verify failure.** `pnpm vitest run src/__tests__/error.test.ts` → FAIL (`Cannot find module '../error'`).

- [ ] **Step 4: Implement `src/error.ts`.** Note: the catalog lives in Task 2; to avoid a cycle, `error.ts` imports only the *entries table* from `./catalog-data` — create that file here with the core entries, and Task 2 re-exports it.

```ts
// src/catalog-data.ts
export interface ErrorCatalogEntry {
  status: number;
  title: string;
  hint?: string;
  docsUrl?: string;
  /** Redaction posture: true → message/hint/data are never echoed to clients. */
  internal?: boolean;
}

export const CORE_ENTRIES = {
  bad_request: { status: 400, title: 'Bad Request' },
  unauthorized: { status: 401, title: 'Unauthorized' },
  forbidden: { status: 403, title: 'Forbidden' },
  not_found: { status: 404, title: 'Not Found' },
  method_not_allowed: { status: 405, title: 'Method Not Allowed' },
  conflict: { status: 409, title: 'Conflict' },
  gone: { status: 410, title: 'Gone' },
  payload_too_large: { status: 413, title: 'Payload Too Large' },
  unsupported_media_type: { status: 415, title: 'Unsupported Media Type' },
  unprocessable: { status: 422, title: 'Unprocessable Entity' },
  too_many_requests: { status: 429, title: 'Too Many Requests' },
  internal: { status: 500, title: 'Internal Server Error', internal: true },
  not_implemented: { status: 501, title: 'Not Implemented' },
  bad_gateway: { status: 502, title: 'Bad Gateway' },
  service_unavailable: { status: 503, title: 'Service Unavailable' },
  gateway_timeout: { status: 504, title: 'Gateway Timeout' },
} as const satisfies Record<string, ErrorCatalogEntry>;

export type CoreErrorCode = keyof typeof CORE_ENTRIES;
```

```ts
// src/error.ts
import { CORE_ENTRIES, type CoreErrorCode } from './catalog-data';

export interface VelaErrorOptions {
  message?: string;
  status?: number;
  hint?: string;
  docsUrl?: string;
  data?: unknown;
  cause?: unknown;
}

/**
 * The one Vela error. Every field is an OWN ENUMERABLE property so the error
 * rides any wire codec / structuredClone / DO-RPC prop-copy with no special
 * serialization path. `type` is the brand `isVelaError` checks — it must
 * survive serialization, which own+enumerable guarantees.
 */
export class VelaError extends Error {
  readonly type = 'VelaError';
  readonly code: string;
  readonly status: number;
  readonly hint?: string;
  readonly docsUrl?: string;
  readonly data?: unknown;

  constructor(code: CoreErrorCode, options?: VelaErrorOptions);
  constructor(code: string, options: VelaErrorOptions & { status: number });
  constructor(code: string, options: VelaErrorOptions = {}) {
    const entry = (CORE_ENTRIES as Record<string, { status: number; title: string; hint?: string; docsUrl?: string }>)[code];
    super(options.message ?? entry?.title ?? code, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'VelaError';
    this.code = code;
    this.status = options.status ?? entry?.status ?? 500;
    if (options.hint ?? entry?.hint) this.hint = options.hint ?? entry?.hint;
    if (options.docsUrl ?? entry?.docsUrl) this.docsUrl = options.docsUrl ?? entry?.docsUrl;
    if (options.data !== undefined) this.data = options.data;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
```

- [ ] **Step 5: Run to verify pass.** `pnpm vitest run src/__tests__/error.test.ts` → PASS. Then `pnpm typecheck` → exit 0.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat: VelaError with own-enumerable branded fields"`

### Task 2: Catalogs — `defineErrorCatalog`, `composeCatalogs`, `STATUS_TO_CODE`

**Files:**
- Create: `/Users/kauan/Projects/velajs/errors/src/catalog.ts`
- Test: `/Users/kauan/Projects/velajs/errors/src/__tests__/catalog.test.ts`

**Interfaces:**
- Consumes: `VelaError`, `VelaErrorOptions`, `CORE_ENTRIES`, `ErrorCatalogEntry` from Task 1.
- Produces: `interface Catalog<C extends string = string> { entries: Readonly<Record<C, ErrorCatalogEntry>>; error(code, opts?): VelaError; has(code: string): boolean; get(code: string): ErrorCatalogEntry | undefined }`; `defineErrorCatalog(entries)`; `composeCatalogs(...catalogs): Catalog` (throws `VelaError('internal')` on duplicate code); `CORE_CATALOG: Catalog<CoreErrorCode>`; `STATUS_TO_CODE: Readonly<Record<number, CoreErrorCode>>`.

- [ ] **Step 1: Failing test** (`src/__tests__/catalog.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { composeCatalogs, CORE_CATALOG, defineErrorCatalog, STATUS_TO_CODE } from '../catalog';
import { VelaError } from '../error';

describe('defineErrorCatalog', () => {
  const storage = defineErrorCatalog({
    bucket_missing: { status: 404, title: 'Bucket not found', hint: 'Check wrangler bindings.' },
    upstream_error: { status: 502, title: 'Upstream provider failed', internal: true },
  });

  it('derives a typed thrower with catalog defaults', () => {
    const err = storage.error('bucket_missing', { message: 'no bucket "media"' });
    expect(err).toBeInstanceOf(VelaError);
    expect(err.status).toBe(404);
    expect(err.hint).toBe('Check wrangler bindings.');
  });

  it('exposes entries and lookup', () => {
    expect(storage.has('upstream_error')).toBe(true);
    expect(storage.get('upstream_error')?.internal).toBe(true);
    expect(storage.get('nope')).toBeUndefined();
  });
});

describe('composeCatalogs', () => {
  it('merges disjoint catalogs', () => {
    const extra = defineErrorCatalog({ order_expired: { status: 410, title: 'Order expired' } });
    const composed = composeCatalogs(CORE_CATALOG, extra);
    expect(composed.has('not_found')).toBe(true);
    expect(composed.has('order_expired')).toBe(true);
  });

  it('throws on duplicate codes at compose time', () => {
    const dup = defineErrorCatalog({ not_found: { status: 404, title: 'shadow' } });
    expect(() => composeCatalogs(CORE_CATALOG, dup)).toThrow(/duplicate error code/i);
  });
});

describe('STATUS_TO_CODE', () => {
  it('maps every core status back to its code', () => {
    expect(STATUS_TO_CODE[404]).toBe('not_found');
    expect(STATUS_TO_CODE[500]).toBe('internal');
  });
});
```

- [ ] **Step 2: Run to verify fail.** `pnpm vitest run src/__tests__/catalog.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/catalog.ts`:**

```ts
import { CORE_ENTRIES, type CoreErrorCode, type ErrorCatalogEntry } from './catalog-data';
import { VelaError, type VelaErrorOptions } from './error';

export type { CoreErrorCode, ErrorCatalogEntry } from './catalog-data';
export { CORE_ENTRIES } from './catalog-data';

export interface Catalog<C extends string = string> {
  readonly entries: Readonly<Record<C, ErrorCatalogEntry>>;
  /** Typed thrower bound to this catalog's defaults. */
  error(code: C | (string & {}), options?: VelaErrorOptions): VelaError;
  has(code: string): boolean;
  get(code: string): ErrorCatalogEntry | undefined;
}

const makeCatalog = <C extends string>(entries: Readonly<Record<C, ErrorCatalogEntry>>): Catalog<C> => ({
  entries,
  error(code, options = {}) {
    const entry = (entries as Record<string, ErrorCatalogEntry>)[code];
    return new VelaError(code, {
      ...options,
      status: options.status ?? entry?.status ?? 500,
      hint: options.hint ?? entry?.hint,
      docsUrl: options.docsUrl ?? entry?.docsUrl,
    });
  },
  has: (code) => code in entries,
  get: (code) => (entries as Record<string, ErrorCatalogEntry>)[code],
});

export const defineErrorCatalog = <const T extends Record<string, ErrorCatalogEntry>>(
  entries: T,
): Catalog<Extract<keyof T, string>> => makeCatalog(entries);

export const composeCatalogs = (...catalogs: Array<Catalog<string>>): Catalog<string> => {
  const merged: Record<string, ErrorCatalogEntry> = {};
  for (const catalog of catalogs) {
    for (const [code, entry] of Object.entries<ErrorCatalogEntry>(catalog.entries)) {
      if (code in merged) {
        throw new VelaError('internal', { message: `duplicate error code '${code}' while composing catalogs` });
      }
      merged[code] = entry;
    }
  }
  return makeCatalog(merged);
};

export const CORE_CATALOG: Catalog<CoreErrorCode> = makeCatalog(CORE_ENTRIES);

export const STATUS_TO_CODE: Readonly<Record<number, CoreErrorCode>> = Object.fromEntries(
  (Object.entries(CORE_ENTRIES) as Array<[CoreErrorCode, ErrorCatalogEntry]>).map(([code, e]) => [e.status, code]),
) as Record<number, CoreErrorCode>;
```

- [ ] **Step 4: Run to verify pass**, then `pnpm typecheck`.
- [ ] **Step 5: Commit.** `git commit -am "feat: composable error catalogs with duplicate detection"`

### Task 3: `isVelaError` branded guard

**Files:**
- Create: `/Users/kauan/Projects/velajs/errors/src/guard.ts`
- Test: `/Users/kauan/Projects/velajs/errors/src/__tests__/guard.test.ts`

**Interfaces:**
- Produces: `interface VelaErrorLike extends Error { type: 'VelaError'; code: string; status: number; hint?: string; docsUrl?: string; data?: unknown }`; `isVelaError(e: unknown): e is VelaErrorLike`.

- [ ] **Step 1: Failing test:**

```ts
import { describe, expect, it } from 'vitest';
import { VelaError } from '../error';
import { isVelaError } from '../guard';

describe('isVelaError', () => {
  it('accepts a real VelaError and subclasses', () => {
    class StorageQuotaError extends VelaError {}
    expect(isVelaError(new VelaError('conflict'))).toBe(true);
    expect(isVelaError(new StorageQuotaError('too_many_requests'))).toBe(true);
  });

  it('accepts a wire-decoded twin (plain Error carrying copied own props)', () => {
    const original = new VelaError('gone', { message: 'expired' });
    const twin = Object.assign(new Error(original.message), { ...original });
    expect(isVelaError(twin)).toBe(true);
  });

  it('REJECTS a foreign error that merely has code+status (plan-119 regression)', () => {
    const foreign = Object.assign(new Error('internal driver detail: host=10.0.0.5'), {
      code: 'PROTOCOL_ERROR',
      status: 502,
    });
    expect(isVelaError(foreign)).toBe(false);
  });

  it('rejects plain errors, wrong-typed fields, and non-errors', () => {
    expect(isVelaError(new Error('x'))).toBe(false);
    expect(isVelaError(Object.assign(new Error('x'), { code: 1, status: 'y', type: 'VelaError' }))).toBe(false);
    expect(isVelaError({ type: 'VelaError', code: 'x', status: 500 })).toBe(false);
    expect(isVelaError(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `src/guard.ts`:**

```ts
/**
 * Structural, realm-safe, BRANDED guard. `instanceof VelaError` is unreliable
 * across DO↔worker RPC and for wire-decoded twins; a bare code+status shape
 * check lets foreign driver errors ride the client-echo path. The brand
 * (`type === 'VelaError'`, an own enumerable prop that survives serialization)
 * closes both failure modes. Nothing load-bearing may use `instanceof`.
 */
export interface VelaErrorLike extends Error {
  type: 'VelaError';
  code: string;
  status: number;
  hint?: string;
  docsUrl?: string;
  data?: unknown;
}

export const isVelaError = (error: unknown): error is VelaErrorLike => {
  if (!(error instanceof Error)) return false;
  const candidate = error as Partial<VelaErrorLike>;
  return typeof candidate.code === 'string' && typeof candidate.status === 'number' && candidate.type === 'VelaError';
};
```

- [ ] **Step 4: Run → PASS; typecheck.**
- [ ] **Step 5: Commit.** `git commit -am "feat: branded structural isVelaError guard (foreign errors cannot ride the echo path)"`

### Task 4: `toErrorBody` — the wire-redaction seam

**Files:**
- Create: `/Users/kauan/Projects/velajs/errors/src/to-error-body.ts`
- Test: `/Users/kauan/Projects/velajs/errors/src/__tests__/to-error-body.test.ts`

**Interfaces:**
- Consumes: `isVelaError`, `Catalog`, `CORE_CATALOG`, `STATUS_TO_CODE`.
- Produces: `interface WireErrorObject { code: string; message: string; hint?: string; details?: unknown; docsUrl?: string }`; `interface ErrorBodyResult { body: { error: WireErrorObject }; status: number; redacted: boolean }`; `toErrorBody(error: unknown, options?: ToErrorBodyOptions): ErrorBodyResult` with `ToErrorBodyOptions { catalog?, fallbackStatus?, redactedMessage?, encodeData?, includeHint? }`.

- [ ] **Step 1: Failing test:**

```ts
import { describe, expect, it } from 'vitest';
import { defineErrorCatalog, composeCatalogs, CORE_CATALOG } from '../catalog';
import { VelaError } from '../error';
import { toErrorBody } from '../to-error-body';

describe('toErrorBody', () => {
  it('redacts anything unbranded (rule 1)', () => {
    const { body, status, redacted } = toErrorBody(new Error('secret host=10.0.0.5'));
    expect(redacted).toBe(true);
    expect(status).toBe(500);
    expect(body.error.code).toBe('internal');
    expect(body.error.message).not.toContain('10.0.0.5');
  });

  it('redacts the plan-119 foreign error', () => {
    const foreign = Object.assign(new Error('internal driver detail: host=10.0.0.5'), {
      code: 'PROTOCOL_ERROR',
      status: 502,
    });
    const { body, redacted } = toErrorBody(foreign);
    expect(redacted).toBe(true);
    expect(body.error.message).not.toContain('10.0.0.5');
  });

  it('redacts branded errors whose catalog entry is internal (rule 2), keeping code+status', () => {
    const catalog = composeCatalogs(CORE_CATALOG, defineErrorCatalog({
      db_corruption: { status: 500, title: 'Storage failure', internal: true },
    }));
    const err = new VelaError('db_corruption', { status: 500, message: 'page 7 checksum mismatch' });
    const { body, redacted } = toErrorBody(err, { catalog });
    expect(redacted).toBe(true);
    expect(body.error.code).toBe('db_corruption');
    expect(body.error.message).not.toContain('checksum');
  });

  it('echoes branded non-internal errors — catalogued or open (rule 3)', () => {
    const { body, status, redacted } = toErrorBody(
      new VelaError('order_expired', { status: 410, message: 'Order 42 expired', hint: 'Create a new order.', data: { id: 42 } }),
    );
    expect(redacted).toBe(false);
    expect(status).toBe(410);
    expect(body.error).toEqual({
      code: 'order_expired',
      message: 'Order 42 expired',
      hint: 'Create a new order.',
      details: { id: 42 },
    });
  });

  it('honors includeHint:false and encodeData', () => {
    const err = new VelaError('conflict', { hint: 'h', data: 7n });
    const { body } = toErrorBody(err, { includeHint: false, encodeData: (d) => String(d) });
    expect(body.error.hint).toBeUndefined();
    expect(body.error.details).toBe('7');
  });

  it('the internal core code is always redacted (invariant channel)', () => {
    const { redacted, body } = toErrorBody(new VelaError('internal', { message: 'invariant: cache poisoned' }));
    expect(redacted).toBe(true);
    expect(body.error.message).not.toContain('poisoned');
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `src/to-error-body.ts`:**

```ts
import { CORE_CATALOG, STATUS_TO_CODE, type Catalog } from './catalog';
import { isVelaError } from './guard';

export interface WireErrorObject {
  code: string;
  message: string;
  hint?: string;
  details?: unknown;
  docsUrl?: string;
}

export interface ErrorBodyResult {
  body: { error: WireErrorObject };
  status: number;
  redacted: boolean;
}

export interface ToErrorBodyOptions {
  /** Composed catalog; defaults to the core catalog. */
  catalog?: Catalog<string>;
  /** Status used for unbranded errors. Default 500. */
  fallbackStatus?: number;
  redactedMessage?: (status: number) => string;
  /** Injectable wire codec for `data` → `details` (bigint/bytes etc.). */
  encodeData?: (data: unknown) => unknown;
  /** Default true. */
  includeHint?: boolean;
}

const defaultRedactedMessage = (status: number, catalog: Catalog<string>): string => {
  const code = STATUS_TO_CODE[status];
  return (code && catalog.get(code)?.title) || 'Internal Server Error';
};

/**
 * THE single wire-redaction seam. Every transport edge (HTTP, WS, live, queue
 * reporting) builds its client-bound error content here, so the invariant
 * "unbranded or internal-coded errors never echo their message" holds
 * identically everywhere. `redacted: true` is the caller's signal to log the
 * raw error server-side — this function never logs (zero-dep purity).
 */
export const toErrorBody = (error: unknown, options: ToErrorBodyOptions = {}): ErrorBodyResult => {
  const catalog = options.catalog ?? CORE_CATALOG;
  const message = options.redactedMessage ?? ((s: number) => defaultRedactedMessage(s, catalog));

  const redact = (status: number, code: string): ErrorBodyResult => ({
    body: { error: { code, message: message(status) } },
    status,
    redacted: true,
  });

  if (!isVelaError(error)) {
    const status = options.fallbackStatus ?? 500;
    return redact(status, STATUS_TO_CODE[status] ?? 'internal');
  }

  const entry = catalog.get(error.code);
  if (error.code === 'internal' || entry?.internal === true) {
    return redact(error.status, error.code);
  }

  const wire: WireErrorObject = { code: error.code, message: error.message };
  const hint = error.hint ?? entry?.hint;
  if (options.includeHint !== false && hint !== undefined) wire.hint = hint;
  const docsUrl = error.docsUrl ?? entry?.docsUrl;
  if (docsUrl !== undefined) wire.docsUrl = docsUrl;
  if (error.data !== undefined) wire.details = options.encodeData ? options.encodeData(error.data) : error.data;
  return { body: { error: wire }, status: error.status, redacted: false };
};
```

- [ ] **Step 4: Run → PASS; typecheck.**
- [ ] **Step 5: Commit.** `git commit -am "feat: toErrorBody single wire-redaction seam"`

### Task 5: Invariants, index, golden fixture, round-trip, release hygiene

**Files:**
- Create: `src/invariant.ts`, `src/index.ts`, `src/__tests__/invariant.test.ts`, `src/__tests__/round-trip.test.ts`, `src/__tests__/wire-fixture.test.ts`, `src/__tests__/types.test-d.ts` (if live-protocol has a test-d setup; otherwise plain type assertions inside `round-trip.test.ts` with `expectTypeOf` from vitest)
- Modify: `README.md` (real content: what/why/rules table/usage snippet)

**Interfaces:**
- Produces: `invariant(condition, message, data?): asserts condition`; `unreachable(value: never, message?): never`; index re-exports EVERYTHING public: `VelaError`, `VelaErrorOptions`, `ErrorCatalogEntry`, `CoreErrorCode`, `CORE_ENTRIES`, `Catalog`, `defineErrorCatalog`, `composeCatalogs`, `CORE_CATALOG`, `STATUS_TO_CODE`, `VelaErrorLike`, `isVelaError`, `WireErrorObject`, `ErrorBodyResult`, `ToErrorBodyOptions`, `toErrorBody`.

- [ ] **Step 1: Failing tests.** `invariant.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { invariant, unreachable } from '../invariant';
import { toErrorBody } from '../to-error-body';

describe('invariant/unreachable', () => {
  it('invariant throws an internal-coded VelaError that redacts on the wire', () => {
    let caught: unknown;
    try {
      invariant(false, 'subscription registry out of sync', { subId: 'abc' });
    } catch (err) {
      caught = err;
    }
    const { redacted, body } = toErrorBody(caught);
    expect(redacted).toBe(true);
    expect(body.error.message).not.toContain('registry');
  });

  it('invariant narrows types', () => {
    const value: string | undefined = 'x' as string | undefined;
    invariant(value !== undefined, 'value required');
    expect(value.length).toBe(1); // compiles only if narrowed
  });

  it('unreachable throws', () => {
    expect(() => unreachable('boom' as never)).toThrow();
  });
});
```

`round-trip.test.ts` (brand survival — THE serialization contract):

```ts
import { describe, expect, it } from 'vitest';
import { isVelaError, toErrorBody, VelaError } from '../index';

describe('brand survives serialization', () => {
  const original = new VelaError('conflict', { message: 'rev mismatch', data: { rev: 3 } });

  it('via JSON spread (wire-codec prop copy)', () => {
    const twin = Object.assign(new Error(original.message), JSON.parse(JSON.stringify({ ...original })));
    expect(isVelaError(twin)).toBe(true);
    expect(toErrorBody(twin).redacted).toBe(false);
  });

  it('via structuredClone (DO RPC analog)', () => {
    const cloned = structuredClone({ ...original });
    const twin = Object.assign(new Error(String(cloned.message ?? original.message)), cloned);
    expect(isVelaError(twin)).toBe(true);
  });
});
```

`wire-fixture.test.ts` (golden — pins the canonical object byte-shape):

```ts
import { describe, expect, it } from 'vitest';
import { toErrorBody, VelaError } from '../index';

// GOLDEN: this exact JSON is the wire contract consumed by @velajs/client.
// Changing it is a breaking protocol change — bump consumers in lockstep.
describe('wire fixture', () => {
  it('canonical echoed body', () => {
    const { body } = toErrorBody(new VelaError('not_found', { message: 'no such route', hint: 'Run `vela route list`.' }));
    expect(JSON.stringify(body)).toBe(
      '{"error":{"code":"not_found","message":"no such route","hint":"Run `vela route list`."}}',
    );
  });

  it('canonical redacted body', () => {
    const { body } = toErrorBody(new Error('x'));
    expect(JSON.stringify(body)).toBe('{"error":{"code":"internal","message":"Internal Server Error"}}');
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** `src/invariant.ts`:

```ts
import { VelaError } from './error';

/** Throws an internal-coded VelaError — rich in server logs, redacted on the wire. */
export function invariant(condition: unknown, message: string, data?: unknown): asserts condition {
  if (!condition) {
    throw new VelaError('internal', { message: `Invariant violation: ${message}`, data });
  }
}

export function unreachable(value: never, message = 'unreachable code reached'): never {
  throw new VelaError('internal', { message, data: { value } });
}
```

`src/index.ts` — named re-exports of every symbol listed in Interfaces above (types via `export type`).

- [ ] **Step 4: Full suite + typecheck + build.** `pnpm test && pnpm typecheck && pnpm build` → all green; `ls dist/index.js dist/index.d.ts` both exist.
- [ ] **Step 5: README** — document the three redaction rules table, the brand contract ("new transport edges must construct real VelaErrors, not shape-alikes"), catalog composition, and a 10-line usage snippet.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat: invariants, public index, golden wire fixtures, README"`

---

## Phase B — vela core integration

All paths below are relative to `/Users/kauan/Projects/velajs/vela`. Before starting: `pnpm add @velajs/errors@file:../errors` (workspace-style local link, matching how `@velajs/live-protocol` is consumed — check `package.json` and mirror that exact dependency form). Run the existing suite first: `pnpm test` must be green before any change.

### Task 6: `ExceptionHandler` contract + default handler + reporter

**Files:**
- Create: `src/exceptions/exception-handler.ts`, `src/exceptions/reporter.ts`, `src/exceptions/index.ts`
- Modify: `src/pipeline/tokens.ts` (add two tokens after `APP_MIDDLEWARE`, line ~40)
- Test: `src/__tests__/exception-handler.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 7–11):

```ts
// tokens
export const APP_EXCEPTION_HANDLER = new InjectionToken<ExceptionHandler>('APP_EXCEPTION_HANDLER');
export const ERROR_CATALOG = new InjectionToken<Catalog<string>>('ERROR_CATALOG');

// exception-handler.ts
export type ErrorMatcher = string | ((error: unknown) => boolean) | (new (...args: never[]) => Error);
export interface ErrorReportContext {
  edge: 'http' | 'ws' | 'live' | 'queue' | 'schedule' | 'hono';
  source?: string;              // e.g. 'CatsController.findAll' or query name
  note?: string;                // e.g. 'exception filter threw'
  [key: string]: unknown;
}
export interface ExceptionHandler {
  report?(error: unknown, ctx: ErrorReportContext): void | Promise<void>;
  dontReport?: ErrorMatcher[];
  context?(error: unknown, ctx: ErrorReportContext): Record<string, unknown>;
  render?(error: unknown, ctx: unknown): Response | ErrorBodyResult | undefined;
}

// reporter.ts
export interface ErrorReporter {
  catalog: Catalog<string>;
  report(error: unknown, ctx: ErrorReportContext): void;   // fire-and-forget, contained
  render(error: unknown, executionCtx: unknown): Response | ErrorBodyResult | undefined;
}
export function resolveErrorReporter(container: Container): ErrorReporter;
```

- [ ] **Step 1: Failing test** (`src/__tests__/exception-handler.test.ts`) — use the repo's existing test bootstrap pattern (see `src/__tests__/queue-openness.test.ts` for how apps are built in tests):

```ts
import { describe, expect, it, vi } from 'vitest';
// import paths per repo convention (relative src imports like sibling tests)
import { resolveErrorReporter } from '../exceptions/reporter';
import { APP_EXCEPTION_HANDLER, ERROR_CATALOG } from '../pipeline/tokens';
import { Container } from '../container/container';
import { defineErrorCatalog, VelaError } from '@velajs/errors';

describe('ErrorReporter', () => {
  it('default reporter console.errors unless diagnostics is silent', () => {
    const container = new Container();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    resolveErrorReporter(container).report(new Error('boom'), { edge: 'http', source: 'X.y' });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('custom handler.report always runs, even under diagnostics silent', () => {
    const container = new Container();
    container.setDiagnostics?.('silent'); // use the actual diagnostics setter — check container/container.ts for the real API
    const report = vi.fn();
    container.register({ provide: APP_EXCEPTION_HANDLER, useValue: { report } });
    resolveErrorReporter(container).report(new Error('boom'), { edge: 'http' });
    expect(report).toHaveBeenCalledOnce();
  });

  it('dontReport suppresses by code, class, and predicate', () => {
    const container = new Container();
    const report = vi.fn();
    container.register({
      provide: APP_EXCEPTION_HANDLER,
      useValue: { report, dontReport: ['not_found', (e: unknown) => (e as Error).message === 'skip'] },
    });
    const reporter = resolveErrorReporter(container);
    reporter.report(new VelaError('not_found'), { edge: 'http' });
    reporter.report(new Error('skip'), { edge: 'http' });
    reporter.report(new Error('loud'), { edge: 'http' });
    expect(report).toHaveBeenCalledOnce();
  });

  it('a throwing report() is contained and never propagates', () => {
    const container = new Container();
    container.register({
      provide: APP_EXCEPTION_HANDLER,
      useValue: { report: () => { throw new Error('reporter bug'); } },
    });
    expect(() => resolveErrorReporter(container).report(new Error('x'), { edge: 'http' })).not.toThrow();
  });

  it('exposes the composed ERROR_CATALOG when provided', () => {
    const container = new Container();
    const catalog = defineErrorCatalog({ order_expired: { status: 410, title: 'Order expired' } });
    container.register({ provide: ERROR_CATALOG, useValue: catalog });
    expect(resolveErrorReporter(container).catalog.has('order_expired')).toBe(true);
  });
});
```

Adjust the two marked lines to the container's real diagnostics/registration API after reading `src/container/container.ts` — do not guess; the test must compile against real signatures without casts.

- [ ] **Step 2: Run → FAIL** (`Cannot find module '../exceptions/reporter'`).
- [ ] **Step 3: Implement.** `src/exceptions/exception-handler.ts` holds the interfaces above plus:

```ts
export const matchesAny = (matchers: ErrorMatcher[] | undefined, error: unknown): boolean => {
  if (!matchers?.length) return false;
  return matchers.some((m) => {
    if (typeof m === 'string') return isVelaError(error) && error.code === m;
    if (typeof m === 'function' && !m.prototype) return (m as (e: unknown) => boolean)(error);
    return error instanceof (m as new () => Error);
  });
};
```

(Note: a class matcher and a predicate are both `typeof 'function'` — discriminate on `m.prototype`: arrow-function predicates have none. Document this constraint in the JSDoc: predicates must be arrow functions.)

`src/exceptions/reporter.ts`:

```ts
import { CORE_CATALOG, type Catalog, type ErrorBodyResult } from '@velajs/errors';
import type { Container } from '../container/container';
import { APP_EXCEPTION_HANDLER, ERROR_CATALOG } from '../pipeline/tokens';
import { matchesAny, type ErrorReportContext, type ExceptionHandler } from './exception-handler';

export interface ErrorReporter {
  catalog: Catalog<string>;
  report(error: unknown, ctx: ErrorReportContext): void;
  render(error: unknown, executionCtx: unknown): Response | ErrorBodyResult | undefined;
}

export const resolveErrorReporter = (container: Container): ErrorReporter => {
  const handler: ExceptionHandler | undefined = container.has(APP_EXCEPTION_HANDLER)
    ? container.resolve(APP_EXCEPTION_HANDLER)
    : undefined;
  const catalog: Catalog<string> = container.has(ERROR_CATALOG) ? container.resolve(ERROR_CATALOG) : CORE_CATALOG;

  return {
    catalog,
    report(error, ctx) {
      if (matchesAny(handler?.dontReport, error)) return;
      const merged = handler?.context ? { ...ctx, ...safeContext(handler, error, ctx) } : ctx;
      if (handler?.report) {
        try {
          void Promise.resolve(handler.report(error, merged)).catch(() => {});
        } catch {
          // A broken reporter must never mask the original error.
        }
        return;
      }
      if (container.getDiagnostics() !== 'silent') {
        console.error(`[vela] ${merged.edge} error${merged.source ? ` in ${merged.source}` : ''}${merged.note ? ` (${merged.note})` : ''}:`, error);
      }
    },
    render(error, executionCtx) {
      try {
        return handler?.render?.(error, executionCtx);
      } catch {
        return undefined; // broken render hook falls through to default render
      }
    },
  };
};

const safeContext = (handler: ExceptionHandler, error: unknown, ctx: ErrorReportContext): Record<string, unknown> => {
  try {
    return handler.context?.(error, ctx) ?? {};
  } catch {
    return {};
  }
};
```

Add to `src/pipeline/tokens.ts` (after `APP_MIDDLEWARE`): the two tokens from Interfaces. Add both to the `markGlobalToken` loop in `src/factory/bootstrap.ts:68`. `src/exceptions/index.ts` re-exports; add `export * from './exceptions'` to the package's public index (find the root `src/index.ts` export list and follow its style), and re-export `VelaError`, `isVelaError`, `defineErrorCatalog`, `composeCatalogs`, `toErrorBody`, `CORE_CATALOG` from `@velajs/errors` so app authors need one import.

- [ ] **Step 4: Run → PASS; `pnpm test` (full suite) still green.**
- [ ] **Step 5: Commit.** `git commit -am "feat(exceptions): ExceptionHandler contract, ErrorReporter, APP_EXCEPTION_HANDLER + ERROR_CATALOG tokens"`

### Task 7: HTTP edge — HandlerExecutor on report-first ordering

**Files:**
- Modify: `src/http/handler-executor.ts:125-153` (the catch block), `src/errors/http-exception.ts` (add `getRawResponse()`)
- Test: `src/__tests__/http-error-edge.test.ts` (new; use `app.request()` e2e style like existing http tests)

**Interfaces:**
- Consumes: `resolveErrorReporter` (Task 6), `toErrorBody`/`STATUS_TO_CODE`/`isVelaError` from `@velajs/errors`.
- Produces: the canonical HTTP error behavior every later task and follow-up cycle relies on (see test).

- [ ] **Step 1: Add `getRawResponse()` to HttpException** (returns the constructor's original `string | Record<string,unknown>` — one line: `getRawResponse(): ExceptionResponse { return this._response; }`).

- [ ] **Step 2: Failing e2e test** — bootstrap a tiny app (mirror an existing `app.request()` test for setup) with five routes and assert:

```ts
// route /bare-http     → throw new NotFoundException('missing thing')
// expect 404 {"error":{"code":"not_found","message":"missing thing"}}
// route /object-http   → throw new BadRequestException({ custom: 'shape', reason: 'legacy' })
// expect 400 {"custom":"shape","reason":"legacy"}            // verbatim — crud compat
// route /vela-error    → throw new VelaError('conflict', { message: 'rev mismatch', data: { rev: 3 } })
// expect 409 {"error":{"code":"conflict","message":"rev mismatch","details":{"rev":3}}}
// route /unknown       → throw new Error('secret sauce')
// expect 500 {"error":{"code":"internal","message":"Internal Server Error"}}; console.error spy called once
// route /filter-throws → controller has a @Catch() filter whose catch() throws; handler throws new Error('original')
// expect 500 canonical redacted body; console.error spy called TWICE (original + 'exception filter threw')
```

Write these as real vitest assertions with a `vi.spyOn(console, 'error')`. Run → FAIL (old shapes).

- [ ] **Step 3: Rewrite the catch block** in `handler-executor.ts` (replacing lines 125–153):

```ts
      } catch (error) {
        const reporter = resolveErrorReporter(requestContainer);
        const source = `${controller.name}.${String(route.handlerName)}`;
        // Report FIRST, always — rendering (filters included) is a separate
        // concern; a filter claiming the error must not make it invisible.
        reporter.report(error, { edge: 'http', source });

        for (const filter of filters) {
          if (shouldFilterCatch(filter, error)) {
            try {
              const filtered = await filter.catch(error, executionContext);
              return mapResponse(c, filtered);
            } catch (filterError) {
              // A broken filter is itself a bug worth logs — then fall through
              // to the default render instead of silently dying here.
              reporter.report(filterError, { edge: 'http', source, note: 'exception filter threw' });
              break;
            }
          }
        }

        const rendered = reporter.render(error, executionContext);
        if (rendered instanceof Response) return rendered;
        if (rendered) return c.json(rendered.body, rendered.status as ContentfulStatusCode);

        if (error instanceof HttpException) {
          const status = error.getStatus() as ContentfulStatusCode;
          const raw = error.getRawResponse();
          if (typeof raw === 'string') {
            return c.json({ error: { code: STATUS_TO_CODE[status] ?? 'internal', message: raw } }, status);
          }
          return c.json(raw, status); // object responses ship verbatim (crud envelope compat)
        }

        const { body, status } = toErrorBody(error, { catalog: reporter.catalog });
        return c.json(body, status as ContentfulStatusCode);
      }
```

Imports to add at top: `resolveErrorReporter` from `../exceptions/reporter`; `STATUS_TO_CODE, toErrorBody` from `@velajs/errors`. Note the old `console.error` + `{statusCode:500,...}` fallback is deleted — the reporter owns logging now. Beware: subclasses constructed with NO argument (e.g. `new NotFoundException()`) pass `undefined` → check what the constructor stores and keep `message` falling back to the exception's `.message` when `raw` is `undefined`: `const raw = error.getRawResponse() ?? error.message;`.

- [ ] **Step 4: Run the new test → PASS. Then the FULL vela suite** (`pnpm test`): existing tests asserting `{statusCode:500,message:'Internal Server Error'}` or bare `{statusCode,message}` shapes will fail — update those assertions to the canonical shapes (this is the sanctioned break; list every updated test file in the commit body).
- [ ] **Step 5: Commit.** `git commit -am "feat(http)!: report-first error ordering + canonical error body (sanctioned wire break)"`

### Task 8: hono `app.onError` — close the middleware bypass

**Files:**
- Modify: `src/application.ts` (`initRoutes()`, line ~55)
- Test: extend `src/__tests__/http-error-edge.test.ts`

- [ ] **Step 1: Failing test:** register hono middleware that throws before any route runs (`app.getHonoApp().use('*', () => { throw new Error('middleware secret'); })` — add middleware via the repo's sanctioned pre-route mechanism if `use` after build doesn't apply; check how tests register middleware) and assert: 500, canonical redacted body, message does NOT contain 'middleware secret', console.error spy called.
- [ ] **Step 2: Implement** in `initRoutes()` after `this.honoApp = await this.routeManager.build();`:

```ts
    this.honoApp.onError((err, c) => {
      const reporter = resolveErrorReporter(this.container);
      reporter.report(err, { edge: 'hono', source: `${c.req.method} ${c.req.path}` });
      const { body, status } = toErrorBody(err, { catalog: reporter.catalog });
      return c.json(body, status as ContentfulStatusCode);
    });
```

- [ ] **Step 3: Test → PASS; full suite green.**
- [ ] **Step 4: Commit.** `git commit -am "feat(http): app.onError fallback — middleware errors can no longer bypass report+redaction"`

### Task 9: WebSocket edge

**Files:**
- Modify: `src/websocket/ws-exception.ts` (rebuild `toErrorFrame`), `src/websocket/ws-dispatcher.ts` (report calls at the catch site ~line 276 and the filter-throw fallback ~lines 337-341 — read the file first, anchor on `runFilters`)
- Test: extend the existing WS dispatcher test file (find it via `grep -rl toErrorFrame src/__tests__ src/websocket`)

- [ ] **Step 1: Failing tests:** (a) a gateway handler throwing `new VelaError('forbidden', { message: 'room is locked' })` produces frame `{ event: 'exception', data: { code: 'forbidden', message: 'room is locked' } }`; (b) throwing `new Error('ws secret')` produces `data: { code: 'internal', message: 'Internal Server Error' }` and the raw message appears only via the report spy; (c) `WsException('custom text')` still produces `data: { message: 'custom text' }` (unchanged).
- [ ] **Step 2: Rebuild `toErrorFrame`:**

```ts
import { toErrorBody, type Catalog } from '@velajs/errors';

/** Default serialization of an uncaught error into the outbound exception frame. */
export function toErrorFrame(error: unknown, catalog?: Catalog<string>): { event: 'exception'; data: unknown } {
  if (error instanceof WsException) {
    const e = error.getError();
    return { event: 'exception', data: typeof e === 'string' ? { message: e } : e };
  }
  const { body } = toErrorBody(error, { catalog });
  return { event: 'exception', data: body.error };
}
```

- [ ] **Step 3: In `ws-dispatcher.ts`:** at the `dispatchMessage` catch, before `runFilters`, add `resolveErrorReporter(container).report(error, { edge: 'ws', source: <gateway>.<method> })` (use whatever container/gateway identifiers are in scope — read the surrounding code); in the filter-throw fallback add a second `report(filterError, { …, note: 'exception filter threw' })`; pass `resolveErrorReporter(container).catalog` into every `toErrorFrame` call site.
- [ ] **Step 4: Tests → PASS; full suite (including the workers-pool config: `pnpm vitest run -c vitest.config.workers.ts` if that's the invocation — check package.json scripts) green.**
- [ ] **Step 5: Commit.** `git commit -am "feat(ws): exception frames through toErrorBody; dispatcher reports before filtering"`

### Task 10: Live engine — close the leak

**Files:**
- Modify: `src/live/live.engine.ts` (`push()` catch, lines ~434-449; leave the `parse` path at ~281-290 as-is per spec)
- Test: extend the live engine test file (find via `grep -rl "live query" src/__tests__ src/live`)

- [ ] **Step 1: Failing tests:** (a) resolver throwing `new Error('SELECT * FROM secrets failed')` on initial subscribe → error frame `code: 'internal'`, message `'Internal Server Error'`, raw text ONLY via report spy; (b) resolver throwing `new VelaError('forbidden', { message: 'not your list' })` → frame `code: 'forbidden'`, message `'not your list'`; (c) resolver throwing `new VelaError('unprocessable', { message: 'bad cursor' })` → frame `code: 'bad_args'`; (d) parse-path behavior unchanged (zod message still echoed).
- [ ] **Step 2: Implement.** Add a private mapper + rewrite the `initial` branch of the `push()` catch:

```ts
  private static liveFrameCode(err: unknown): LiveErrorCode {
    if (!isVelaError(err)) return LIVE_ERROR_CODES.INTERNAL;
    if (err.status === 403) return LIVE_ERROR_CODES.FORBIDDEN;
    if (err.status === 400 || err.status === 422) return LIVE_ERROR_CODES.BAD_ARGS;
    return LIVE_ERROR_CODES.INTERNAL;
  }
```

```ts
    } catch (err) {
      if (initial) {
        conn.subs.delete(record.sub);
        const reporter = resolveErrorReporter(this.container);
        reporter.report(err, { edge: 'live', source: record.query });
        const safe = toErrorBody(err, { catalog: reporter.catalog });
        this.sendFrame(conn.client, {
          t: 'error',
          sub: record.sub,
          code: LiveEngine.liveFrameCode(err),
          message: safe.body.error.message,
          fatal: true,
        });
      } else if (this.container.getDiagnostics() !== 'silent') {
        // Transient: baseline untouched, the subscription retries next flush.
        console.warn(`[vela] live query '${record.query}' re-run failed (will retry):`, err);
      }
      return;
    }
```

(Adjust `LiveEngine` to the actual class name in the file; `isVelaError`, `toErrorBody` imports from `@velajs/errors`; `LiveErrorCode`/`LIVE_ERROR_CODES` already imported from `@velajs/live-protocol`.)

- [ ] **Step 3: Tests → PASS; full suite green.**
- [ ] **Step 4: Commit.** `git commit -am "fix(live)!: initial-subscribe resolver errors are redacted through toErrorBody (closes raw-message leak)"`

### Task 11: Queue + schedule edges — report, then rethrow

**Files:**
- Modify: `src/queue/queue.dispatch.ts` (catch at ~160-168), `src/queue/queue.binding.ts` (`routeError` default arm, ~58-69), `src/schedule-node/schedule.executor.ts` (catch at ~74-80)
- Test: extend the queue dispatch tests (find via `grep -rl dispatchQueueJob src/__tests__`)

- [ ] **Step 1: Failing tests:** (a) a processor throwing still REJECTS the dispatch (platform retry preserved) AND the report spy fired before the rejection; (b) with a custom `APP_EXCEPTION_HANDLER` whose `report` records calls, the inline driver's fire-and-forget default path routes through it instead of bare `console.error`.
- [ ] **Step 2: Implement.** In `dispatchToProcessor`'s catch (queue.dispatch.ts:160):

```ts
    } catch (error) {
      resolveErrorReporter(scope).report(error, {
        edge: 'queue',
        source: `${processorClass.name}.${String(handler.methodName)}`,
      });
      for (const filter of filters) {
        if (shouldFilterCatch(filter, error)) {
          await filter.catch(error, context);
          return true;
        }
      }
      throw error; // unclaimed → platform retry semantics stay intact
    }
```

In `queue.binding.ts`'s `routeError` non-silent/non-throw arm, replace the bare `console.error` with `resolveErrorReporter(container).report(error, { edge: 'queue', note: 'inline driver' })` (thread the container through if not in scope — read the file). Same pattern for `schedule.executor.ts`'s `console.warn` arm with `edge: 'schedule'`.

- [ ] **Step 3: Tests → PASS; full suite green.**
- [ ] **Step 4: Commit.** `git commit -am "feat(queue,schedule): report-then-rethrow — dispatch errors reach the exception handler without losing platform retries"`

### Task 12: `ErrorsModule` + app API + docs

**Files:**
- Create: `src/exceptions/errors.module.ts`
- Modify: `src/application.ts` (add `useGlobalExceptionHandler`), the public index, `ROADMAP.md` (mark the exception-layer item DONE with a pointer to the spec), `CHANGELOG.md`
- Test: `src/__tests__/errors-module.test.ts`

**Interfaces:**
- Produces: `ErrorsModule.forRoot({ catalogs?: Catalog<string>[]; handler?: Type<ExceptionHandler> | ExceptionHandler })` — composes `[CORE_CATALOG, ...catalogs]` via `composeCatalogs` and provides `ERROR_CATALOG` + (when given) `APP_EXCEPTION_HANDLER`; `app.useGlobalExceptionHandler(handler)` as the imperative sibling.

- [ ] **Step 1: Failing test:** boot an app importing `ErrorsModule.forRoot({ catalogs: [appCatalog], handler: { report: spy } })`; throw `appCatalog.error('order_expired')` from a route → 410 canonical body with the catalog's hint; spy called. Second test: duplicate code across two catalogs → bootstrap rejects (assert the boot throws with `/duplicate error code/`).
- [ ] **Step 2: Implement** with `defineModule` (read `src/module/define-module.ts`'s authoring contract / MODULE_AUTHORING.md first; mirror how an existing defineModule module — e.g. Cors — provides options-derived providers). Providers: `{ provide: ERROR_CATALOG, useValue: composeCatalogs(CORE_CATALOG, ...(options.catalogs ?? [])) }` and, when `options.handler` is set, `{ provide: APP_EXCEPTION_HANDLER, useValue|useClass: options.handler }`. `useGlobalExceptionHandler(handler)` registers the same token on the root container (mirror `useGlobalFilters`' delegation style but via `container.register`).
- [ ] **Step 3: Tests → PASS; full suite + `pnpm vitest run -c vitest.config.workers.ts` green; `tsc --noEmit` green.**
- [ ] **Step 4: Docs.** ROADMAP: replace the pending "Exception-handler layer" bullet with a DONE strikethrough + spec pointer (match the file's existing DONE style). CHANGELOG: minor-version entry listing the sanctioned wire break, the new module/tokens, and the live-leak fix.
- [ ] **Step 5: Commit.** `git commit -am "feat(exceptions): ErrorsModule.forRoot + useGlobalExceptionHandler; roadmap/changelog"`

---

## Final verification (run after Task 12)

- [ ] `errors/`: `pnpm test && pnpm typecheck && pnpm build` → green.
- [ ] `vela/`: `pnpm test` + workers config suite + `tsc --noEmit` → green.
- [ ] Grep-proof the invariant: `grep -rn "err.message\|error.message" src/live src/websocket src/http | grep -v test` — every client-bound occurrence must flow through `toErrorBody` or `WsException`/`HttpException` verbatim paths; justify any exception in the commit message.
- [ ] Run `/verify` (project verify skill) against a demo app: hit the five HTTP routes from Task 7's test matrix manually via `app.request()` or `curl` on a dev server and eyeball the bodies.
- [ ] Do NOT push either repo — leave commits local for user review (concurrent-session protocol: coordinate `push HEAD:main` with the user).
