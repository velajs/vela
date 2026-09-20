/**
 * Conformance contract: descriptor types + exact-assertion helpers.
 *
 * Ported from hono-crud's tests/conformance/contract.ts (the parity spec) onto
 * the native @velajs/crud engine. This suite runs ONE set of contract cells
 * against the native engine through the real HTTP surface, asserting exact
 * status codes and exact error-envelope shapes.
 *
 * Trimmed from the source: capability flags and AdapterContext extras that only
 * the not-yet-ported cells (encryption, versioning/audit, batch/extended verbs,
 * relation scoping) consume. Group-1 cells need only `timestampKind` (managed
 * fields) and `uniqueConstraints` (the deferred unique-conflict skip).
 */
import { beforeAll, beforeEach, expect } from 'vitest';

// ============================================================================
// Adapter descriptor
// ============================================================================

/** Minimal surface of a mounted conformance app (a Vela Hono app wrapper). */
export interface ConformanceApp {
  request(path: string, init?: RequestInit): Promise<Response>;
}

export interface ConformanceCapabilities {
  /**
   * Whether the backing store enforces the model's unique column (email).
   * The memory adapter has no constraint surface and the framework has no
   * model-level unique declaration, so it genuinely cannot run the
   * unique-conflict cell. Skips referencing this capability are named.
   */
  uniqueConstraints: boolean;
  /**
   * 'epoch-ms': library-managed timestamps (`Model.timestamps: true`,
   * numbers from `Date.now()`).
   * 'iso-datetime': DB-managed timestamps.
   * Either way the contract is: both fields set on create, `updatedAt`
   * strictly bumped on update, `createdAt` immutable.
   */
  timestampKind: 'epoch-ms' | 'iso-datetime';
  /**
   * Whether this leg mounts an owner-scoped self-relation (`parent` belongsTo
   * via `parentId`, scoped to the tenant + soft-delete columns) so the
   * relation-include scoping cell can run.
   */
  relationScoping: boolean;
}

/**
 * How tenant scoping is wired for a given adapter leg. Memory uses a dedicated
 * nullable `tenantId` column; the `multiTenant()` resolver reads `headerName`
 * (its `X-Tenant-ID` default) and publishes the id as the `tenantId` context
 * var the engine scopes on.
 */
export interface TenantWiring {
  /** Model field carrying the tenant discriminator. */
  field: string;
  /** Header read by the `multiTenant()` middleware (its default). */
  headerName: string;
  tenantA: string;
  tenantB: string;
}

export interface AdapterContext {
  app: ConformanceApp;
  /** Wipe all rows. Runs in beforeEach. */
  reset(): Promise<void> | void;
  teardown?(): Promise<void> | void;
}

export interface AdapterDescriptor {
  name: string;
  capabilities: ConformanceCapabilities;
  tenant: TenantWiring;
  setup(): Promise<AdapterContext>;
}

/** Lazily resolves the context built in the suite's beforeAll. */
export type CtxGetter = () => AdapterContext;

/**
 * Wire one adapter descriptor's lifecycle into the current test file:
 * `setup()` once (beforeAll), `reset()` before every test, optional
 * `teardown()` afterwards. Returns a lazy context getter (the context only
 * exists after beforeAll runs). Mirrors hono-crud's cells/index.ts lifecycle,
 * scoped per flattened `.test.ts` file.
 */
export function setupConformance(descriptor: AdapterDescriptor): CtxGetter {
  let context: AdapterContext | undefined;

  beforeAll(async () => {
    context = await descriptor.setup();
  });

  beforeEach(async () => {
    if (!context) {
      throw new Error(`conformance context for '${descriptor.name}' is not initialised`);
    }
    await context.reset();
  });

  return () => {
    if (!context) {
      throw new Error(`conformance context for '${descriptor.name}' is not initialised`);
    }
    return context;
  };
}

// ============================================================================
// Response envelopes (the canonical shapes, pinned exactly)
// ============================================================================

/** Canonical error envelope. */
export interface ErrorEnvelope {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

export interface SuccessEnvelope<T> {
  success: true;
  result: T;
}

/** Offset-pagination metadata (PaginatedResult.result_info). */
export interface ResultInfo {
  page: number;
  per_page: number;
  total_count: number;
  total_pages: number;
  has_next_page: boolean;
  has_prev_page: boolean;
}

export interface ListEnvelope<T> {
  success: true;
  result: T[];
  result_info: ResultInfo;
}

/**
 * Cursor-mode pagination metadata (keyset walks, next-only / Stripe-style).
 * Exact shape pinned by the cursor-pagination cell: `page` is always 0, no
 * `total_pages`, no `prev_cursor` — `next_cursor` only while more rows exist.
 */
export interface CursorResultInfo {
  page: 0;
  per_page: number;
  total_count: number;
  has_next_page: boolean;
  has_prev_page: boolean;
  next_cursor?: string;
}

export interface CursorListEnvelope<T> {
  success: true;
  result: T[];
  result_info: CursorResultInfo;
}

/** Single upsert: `{ success, result, created }`, 201 created / 200 updated. */
export interface UpsertEnvelope<T> {
  success: true;
  result: T;
  created: boolean;
}

/**
 * BatchUpsert request body is a BARE ARRAY of items (unlike batchCreate's
 * `{ items: [...] }`); each result item wraps the record in `data` plus a
 * per-item `created` flag.
 */
export interface BatchUpsertItem<T> {
  data: T;
  created: boolean;
}

export interface BatchUpsertResult<T> {
  items: BatchUpsertItem<T>[];
  createdCount: number;
  updatedCount: number;
  totalCount: number;
}

export interface BatchCreateResult<T> {
  created: T[];
  count: number;
}

export interface BatchDeleteResult<T> {
  deleted: T[];
  count: number;
}

/** A conformance record as returned over HTTP. */
export interface ConformanceRecord {
  id: string;
  name: string;
  email: string;
  role: string;
  age?: number | null;
  deletedAt?: number | null;
  createdAt?: number | string;
  updatedAt?: number | string;
  [field: string]: unknown;
}

// ============================================================================
// HTTP + assertion helpers
// ============================================================================

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function jsonInit(
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

export async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/**
 * Asserts the exact error contract: status code, `success: false`, exact
 * `error.code`, and a non-empty `error.message` string.
 */
export async function expectError(
  response: Response,
  status: number,
  code: string,
): Promise<ErrorEnvelope> {
  expect(response.status).toBe(status);
  const body = await readJson<ErrorEnvelope>(response);
  expect(body.success).toBe(false);
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe('string');
  expect(body.error.message.length).toBeGreaterThan(0);
  return body;
}

/** Asserts exact status + `success: true` and returns the result payload. */
export async function expectSuccess<T>(response: Response, status: number): Promise<T> {
  expect(response.status).toBe(status);
  const body = await readJson<SuccessEnvelope<T>>(response);
  expect(body.success).toBe(true);
  return body.result;
}

/** Asserts a 200 list envelope and returns it (result + result_info). */
export async function expectList(response: Response): Promise<ListEnvelope<ConformanceRecord>> {
  expect(response.status).toBe(200);
  const body = await readJson<ListEnvelope<ConformanceRecord>>(response);
  expect(body.success).toBe(true);
  expect(Array.isArray(body.result)).toBe(true);
  return body;
}

/** POSTs a record and asserts the exact create contract (201 + uuid id). */
export async function createRecord(
  app: ConformanceApp,
  basePath: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<ConformanceRecord> {
  const response = await app.request(basePath, jsonInit('POST', body, headers));
  const result = await expectSuccess<ConformanceRecord>(response, 201);
  expect(result.id).toMatch(UUID_V4);
  return result;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalizes a timestamp value to epoch milliseconds, asserting the
 * capability-declared representation on the way.
 */
export function timestampToMillis(
  value: unknown,
  kind: ConformanceCapabilities['timestampKind'],
): number {
  if (kind === 'epoch-ms') {
    expect(typeof value).toBe('number');
    return value as number;
  }
  expect(typeof value).toBe('string');
  const millis = Date.parse(value as string);
  expect(Number.isNaN(millis)).toBe(false);
  return millis;
}
