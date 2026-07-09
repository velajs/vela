/**
 * Query-verb family: search, aggregate, export, import. Executors register
 * here and surface through `./registry`.
 *
 * Pipeline mirrors the read-shaped core verbs (`../verbs.ts` `executeList`):
 * filters are parsed, tenant-scoped, and policy-pushed via `scopeListQuery`;
 * every adapter call runs inside `config.adapter.transaction()`; the returned
 * rows are read-policy filtered (`filterReadable`) then shaped (computed → mask
 * → selection). The adapter's native capability is used when declared
 * (`nativeSearch` → `search`, `aggregate` → `aggregate`); otherwise the engine
 * runs the in-memory fallback over a full `adapter.list` scan.
 *
 * Parity sources (hono-crud 0.13):
 *  - search   → `endpoints/search.ts` + `endpoints/search-utils.ts`.
 *  - aggregate→ `endpoints/aggregate.ts` + `core/aggregate.ts`.
 *  - export   → `endpoints/export.ts` + `utils/csv.ts`.
 *  - import   → `endpoints/import.ts` + `utils/csv.ts`.
 *
 * Intentional deviations from hono-crud (see PARITY.md), all HARDENING:
 *  - search + export APPLY read-policy row filtering + field masking (hono-crud
 *    omitted both — a documented leak vs. list/read).
 *  - import injects + scopes the request tenant (hono-crud import had no tenant
 *    scoping at all).
 *  - search's missing/short `q` throws `VALIDATION_ERROR` (hono-crud used a
 *    Zod-layer 400 / `INVALID_QUERY`), matching the native error taxonomy.
 */

import type { AdapterScope } from '../../adapter/contract';
import type {
  FilterCondition,
  ListQuery,
  Lookup,
  Page,
  SearchHit,
  SearchQuery,
} from '../../adapter/query-types';
import { InputValidationException } from '../../envelope/errors';
import { applyComputedFieldsToArray } from '../../model/computed-fields';
import { applyManagedInsertFields, applyManagedUpdateFields } from '../../model/managed-fields';
import { applyUpsertRestore, isSoftDeleted } from '../../model/soft-delete';
import { filterReadable, maskFields } from '../../policies/evaluate';
import { buildAggregateSpec, computeAggregateFallback } from '../../query/aggregate';
import { parseListFilters } from '../../query/filters';
import { resolveOffsetPagination } from '../../query/pagination';
import { parseSearchMode, runSearchFallback, type SearchFieldConfig } from '../../query/search';
import { generateCsv, parseCsv } from '../../csv/index';
import type { CrudEndpointName } from '../../verb-table';
import type { EngineRequest, EngineResult } from '../engine-request';
import { envelopeOf } from '../resource';
import {
  buildPolicyContext,
  createSchemaFor,
  listParseOptions,
  scopeListQuery,
  shapeOne,
  tenantFilters,
  type AnyResource,
} from '../verb-helpers';
import type { VerbExecutor } from './registry';

type Row = Record<string, unknown>;

/** Per-page ceiling used to scan every matching row for the in-memory fallbacks. */
const FULL_SCAN_PER_PAGE = Number.MAX_SAFE_INTEGER;

/** Maximum rows a single export streams (hono-crud `maxExportRecords`). */
const MAX_EXPORT_RECORDS = 10_000;

/** Minimum search-query length (hono-crud `minQueryLength`). */
const MIN_QUERY_LENGTH = 2;

/** Default row cap for a single import request (hono-crud `maxBatchSize`). */
const DEFAULT_IMPORT_MAX = 1_000;

/** First value of a possibly-repeated query param. */
function firstParam(
  query: Record<string, string | string[]> | undefined,
  key: string,
): string | undefined {
  const raw = query?.[key];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

// ===========================================================================
// search — GET /search
// ===========================================================================

/** Resolve the weighted searchable fields: `search.fields` else `searchFields` (weight 1). */
function resolveSearchFields(resource: AnyResource): Record<string, SearchFieldConfig> {
  const configured = resource.config.search?.fields;
  if (configured && Object.keys(configured).length > 0) return configured;
  const out: Record<string, SearchFieldConfig> = {};
  for (const field of resource.config.searchFields ?? []) out[field] = { weight: 1 };
  return out;
}

/** Parse a comma-separated `?fields=` restrictor, intersected with configured fields. */
function parseRequestedFields(raw: string | undefined, configured: Record<string, unknown>): string[] {
  if (!raw) return [];
  const available = Object.keys(configured);
  return raw
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && available.includes(f));
}

/**
 * Full-text search. Weighted-field scoring, `any`/`all`/`phrase` modes,
 * optional highlighting, and offset pagination. The hit wrapper is
 * `{ item, score, highlights?, matchedFields }`; `result_info` carries the page
 * metadata plus `query` + `searchedFields` (hono-crud parity). Read-policy
 * filtering + field masking are applied to the hit records (hardening).
 */
async function executeSearch(resource: AnyResource, req: EngineRequest): Promise<EngineResult> {
  const config = resource.config;
  const policyCtx = buildPolicyContext(req);

  const term = firstParam(req.query, 'q');
  if (term === undefined || term.trim().length < MIN_QUERY_LENGTH) {
    throw new InputValidationException(
      `Search query must be at least ${MIN_QUERY_LENGTH} characters`,
    );
  }

  const mode = parseSearchMode(firstParam(req.query, 'mode'));
  const highlight = firstParam(req.query, 'highlight') === 'true';
  const minScoreRaw = firstParam(req.query, 'minScore');
  const minScore =
    minScoreRaw !== undefined ? Math.max(0, Math.min(1, Number.parseFloat(minScoreRaw) || 0)) : 0;

  const searchFieldsConfig = resolveSearchFields(resource);
  const requested = parseRequestedFields(firstParam(req.query, 'fields'), searchFieldsConfig);
  const activeFields = requested.length > 0 ? requested : Object.keys(searchFieldsConfig);

  const { page, perPage } = resolveOffsetPagination(req.query ?? {}, {
    defaultPerPage: config.pagination?.defaultPerPage,
    maxPerPage: config.pagination?.maxPerPage,
  });

  const parsed = parseListFilters(req.query ?? {}, listParseOptions(resource));
  const scoped = scopeListQuery(resource, req, policyCtx, parsed);

  const searchQuery: SearchQuery = {
    term,
    mode,
    fields: activeFields.map((field) => ({
      field,
      weight: searchFieldsConfig[field]?.weight ?? 1,
    })),
    filters: scoped.filters,
    options: { ...scoped.options, page: 1, per_page: FULL_SCAN_PER_PAGE },
  };

  const adapterSearch = config.adapter.search;
  const hits: Array<SearchHit<Row>> =
    config.adapter.capabilities.has('nativeSearch') && adapterSearch
      ? await config.adapter.transaction((scope) => adapterSearch(searchQuery, scope))
      : await config.adapter.transaction(async (scope) => {
          const scan = (await config.adapter.list(
            {
              filters: scoped.filters,
              options: { ...scoped.options, page: 1, per_page: FULL_SCAN_PER_PAGE },
            },
            scope,
          )) as Page<Row>;
          return runSearchFallback(scan.result, searchQuery);
        });

  // minScore threshold + read-policy row filtering (hardening vs. hono-crud).
  let matched = hits.filter((hit) => hit.score >= minScore);
  const readable = await filterReadable(policyCtx, matched.map((h) => h.record), resource.model.policies);
  if (readable.length !== matched.length) {
    const allow = new Set(readable);
    matched = matched.filter((hit) => allow.has(hit.record));
  }

  const totalCount = matched.length;
  const start = (page - 1) * perPage;
  const pageHits = matched.slice(start, start + perPage);

  const resultItems = await Promise.all(
    pageHits.map(async (hit) => {
      const shaped = await shapeOne(resource, policyCtx, req, hit.record);
      const item: Record<string, unknown> = {
        item: shaped,
        score: hit.score,
        matchedFields: hit.matchedFields ?? [],
      };
      if (highlight && hit.highlights && Object.keys(hit.highlights).length > 0) {
        item.highlights = hit.highlights;
      }
      return item;
    }),
  );

  const info = {
    page,
    per_page: perPage,
    total_count: totalCount,
    total_pages: Math.ceil(totalCount / perPage),
    query: term,
    searchedFields: activeFields,
  };
  return { status: 200, body: envelopeOf(resource).success(resultItems, info) };
}

// ===========================================================================
// aggregate — GET /aggregate
// ===========================================================================

/**
 * Multi-aggregation query. `buildAggregateSpec` validates the requested
 * operations, groupBy, HAVING, ordering, and group pagination; the adapter's
 * native `aggregate` runs it when declared, else the engine computes it in
 * memory over a full tenant-scoped, policy-pushed `adapter.list` scan. The
 * response is `{ success, result }` where `result` is `{ values }` (ungrouped)
 * or `{ groups, totalGroups }` (grouped).
 */
async function executeAggregate(resource: AnyResource, req: EngineRequest): Promise<EngineResult> {
  const config = resource.config;
  const policyCtx = buildPolicyContext(req);

  const parsed = parseListFilters(req.query ?? {}, listParseOptions(resource));
  const scoped = scopeListQuery(resource, req, policyCtx, parsed);
  // May throw AggregationException (400) — thrown outside the transaction.
  const spec = buildAggregateSpec(req.query ?? {}, config.aggregate ?? {}, scoped.filters);

  const adapterAggregate = config.adapter.aggregate;
  const result = await config.adapter.transaction(async (scope) => {
    if (config.adapter.capabilities.has('aggregate') && adapterAggregate) {
      return adapterAggregate(spec, scope);
    }
    const scan = (await config.adapter.list(
      {
        filters: scoped.filters,
        options: { ...scoped.options, page: 1, per_page: FULL_SCAN_PER_PAGE },
      },
      scope,
    )) as Page<Row>;
    return computeAggregateFallback(scan.result, spec);
  });

  return { status: 200, body: envelopeOf(resource).success(result) };
}

// ===========================================================================
// export — GET /export
// ===========================================================================

/** Sanitized `<table>-export-<iso>.<format>` filename (hono-crud parity). */
function exportFilename(tableName: string, format: string): string {
  const baseName = tableName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${baseName}-export-${timestamp}.${format}`;
}

/**
 * Export the filtered, tenant-scoped list as CSV (`?format=csv`) or JSON
 * (default). Rows are read-policy filtered + field-masked (hardening) and
 * computed fields materialized before serialization. CSV emits a `text/csv`
 * string body with a download `Content-Disposition`; JSON emits
 * `{ success, result: { data, count, format, exportedAt } }`.
 */
async function executeExport(resource: AnyResource, req: EngineRequest): Promise<EngineResult> {
  const config = resource.config;
  const model = resource.model;
  const policyCtx = buildPolicyContext(req);
  const format = firstParam(req.query, 'format') === 'csv' ? 'csv' : 'json';

  const parsed = parseListFilters(req.query ?? {}, listParseOptions(resource));
  const scoped = scopeListQuery(resource, req, policyCtx, parsed);

  const rows = await config.adapter.transaction(async (scope) => {
    const scan = (await config.adapter.list(
      {
        filters: scoped.filters,
        options: { ...scoped.options, page: 1, per_page: MAX_EXPORT_RECORDS },
      },
      scope,
    )) as Page<Row>;
    return scan.result;
  });

  const readable = await filterReadable(policyCtx, rows, model.policies);
  let shaped = await applyComputedFieldsToArray(model, readable);
  shaped = shaped.map((row) => maskFields(policyCtx, row, model.policies) as Row);

  const filename = exportFilename(model.tableName, format);
  if (format === 'csv') {
    return {
      status: 200,
      body: generateCsv(shaped),
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    };
  }

  const result = {
    data: shaped,
    count: shaped.length,
    format,
    exportedAt: new Date().toISOString(),
  };
  return {
    status: 200,
    body: envelopeOf(resource).success(result),
    headers: { 'Content-Disposition': `attachment; filename="${filename}"` },
  };
}

// ===========================================================================
// import — POST /import
// ===========================================================================

type ImportRowStatus = 'created' | 'updated' | 'skipped' | 'failed';

interface ImportRowResult {
  rowNumber: number;
  status: ImportRowStatus;
  data?: Row;
  error?: string;
  validationErrors?: Array<{ path: string; message: string }>;
}

interface ImportSummary {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

function parseBoolParam(value: string | undefined, fallback: boolean): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/**
 * Normalize the import payload into rows. Accepts a CSV string body, a bare
 * JSON array, or `{ items: [...] }`. Empty / oversized / unrecognized payloads
 * raise a loud 400.
 */
function parseImportItems(body: unknown, maxBatchSize: number): Row[] {
  let items: unknown[];
  if (typeof body === 'string') {
    const parsed = parseCsv(body);
    if (parsed.errors.length > 0) {
      throw new InputValidationException(
        `CSV parsing errors: ${parsed.errors.map((e) => `Row ${e.row}: ${e.message}`).join('; ')}`,
      );
    }
    if (parsed.data.length === 0) throw new InputValidationException('CSV content is empty');
    items = parsed.data;
  } else if (Array.isArray(body)) {
    items = body;
  } else if (body !== null && typeof body === 'object' && Array.isArray((body as { items?: unknown }).items)) {
    items = (body as { items: unknown[] }).items;
  } else {
    throw new InputValidationException(
      'Request body must be CSV text, a JSON array, or an object with an "items" array',
    );
  }

  if (items.length === 0) throw new InputValidationException('No rows to import');
  if (items.length > maxBatchSize) {
    throw new InputValidationException(`Maximum ${maxBatchSize} items allowed per import`);
  }
  return items as Row[];
}

/** Tenant-scoped, soft-delete-INCLUSIVE find by the conflict keys (match-and-restore). */
async function findExistingByKeys(
  resource: AnyResource,
  req: EngineRequest,
  keys: string[],
  data: Row,
  scope: AdapterScope,
): Promise<Row | null> {
  const filters: FilterCondition[] = keys.map((key) => ({ field: key, operator: 'eq', value: data[key] }));
  const tenantField = resource.model.tenantField;
  if (tenantField !== undefined && req.vars?.tenantId !== undefined) {
    filters.push({ field: tenantField, operator: 'eq', value: req.vars.tenantId });
  }
  const query: ListQuery = { filters, options: { withDeleted: true, page: 1, per_page: 1 } };
  const found = (await resource.config.adapter.list(query, scope)) as Page<Row>;
  return (found.result[0] as Row | undefined) ?? null;
}

/** Validate + persist one import row, returning its per-row result (never throws). */
async function processImportRow(
  resource: AnyResource,
  req: EngineRequest,
  createSchema: AnyResource['createSchema'],
  data: Row,
  rowNumber: number,
  mode: 'create' | 'upsert',
  skipInvalid: boolean,
  upsertKeys: string[],
  databaseGeneratedId: boolean,
  scope: AdapterScope,
): Promise<ImportRowResult> {
  const model = resource.model;
  const adapter = resource.config.adapter;

  const parsed = createSchema.safeParse(data);
  if (!parsed.success) {
    const issues = (parsed.error as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues;
    return {
      rowNumber,
      status: skipInvalid ? 'skipped' : 'failed',
      error: 'Validation failed',
      validationErrors: issues.map((iss) => ({ path: iss.path.join('.'), message: iss.message })),
    };
  }
  const values = parsed.data as Row;
  if (model.tenantField !== undefined && req.vars?.tenantId !== undefined) {
    values[model.tenantField] = req.vars.tenantId;
  }

  try {
    const existing = await findExistingByKeys(resource, req, upsertKeys, data, scope);

    if (mode === 'upsert') {
      if (existing) {
        const pk = model.primaryKeys[0] ?? 'id';
        const lookup: Lookup = {
          field: pk,
          value: String(existing[pk]),
          filters: tenantFilters(resource, req),
        };
        if (isSoftDeleted(model, existing) && adapter.restore) {
          await adapter.restore(lookup, scope);
        }
        const patch = applyUpsertRestore(model, applyManagedUpdateFields(model, values), existing) as Row;
        const updated = (await adapter.update(lookup, patch, scope)) as Row | null;
        if (!updated) return { rowNumber, status: 'failed', error: 'Record not found for update' };
        return { rowNumber, status: 'updated', data: updated };
      }
    } else if (existing) {
      return {
        rowNumber,
        status: skipInvalid ? 'skipped' : 'failed',
        error: skipInvalid ? 'Record already exists' : 'Record already exists (duplicate key)',
      };
    }

    const managed = applyManagedInsertFields(model, values, { databaseGeneratedId });
    const created = (await adapter.create(managed, scope)) as Row;
    return { rowNumber, status: 'created', data: created };
  } catch (err) {
    return { rowNumber, status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Bulk import from CSV text or JSON. Per-row create (`?mode=create`, default) or
 * upsert (`?mode=upsert`) with per-row validation + result reporting. Invalid
 * rows and create-mode duplicates are `skipped` by default (`?skipInvalid`);
 * `?stopOnError` halts after the first `failed` row. Returns
 * `{ success, result: { summary, results } }` — 207 on strict partial failure
 * (`0 < failed < total`), else 200.
 */
async function executeImport(resource: AnyResource, req: EngineRequest): Promise<EngineResult> {
  const config = resource.config;
  const model = resource.model;

  const mode = firstParam(req.query, 'mode') === 'upsert' ? 'upsert' : 'create';
  const skipInvalid = parseBoolParam(firstParam(req.query, 'skipInvalid'), true);
  const stopOnError = parseBoolParam(firstParam(req.query, 'stopOnError'), false);
  const maxBatchSize = config.batch?.maxBatchSize ?? DEFAULT_IMPORT_MAX;

  const rows = parseImportItems(req.body, maxBatchSize);
  const upsertKeys = config.upsert?.keys ?? model.primaryKeys;
  const databaseGeneratedId = config.adapter.capabilities.has('databaseGeneratedId');

  const summary: ImportSummary = { total: rows.length, created: 0, updated: 0, skipped: 0, failed: 0 };
  const results: ImportRowResult[] = [];
  const createSchema = await createSchemaFor(resource, req);

  await config.adapter.transaction(async (scope) => {
    for (let i = 0; i < rows.length; i++) {
      const result = await processImportRow(
        resource,
        req,
        createSchema,
        rows[i],
        i + 1,
        mode,
        skipInvalid,
        upsertKeys,
        databaseGeneratedId,
        scope,
      );
      results.push(result);
      summary[result.status]++;
      if (stopOnError && result.status === 'failed') break;
    }
  });

  const status = summary.failed > 0 && summary.failed < summary.total ? 207 : 200;
  return { status, body: envelopeOf(resource).success({ summary, results }) };
}

export const queryVerbExecutors: Partial<Record<CrudEndpointName, VerbExecutor>> = {
  search: executeSearch,
  aggregate: executeAggregate,
  export: executeExport,
  import: executeImport,
};
