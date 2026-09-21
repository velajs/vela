import { lookupFromRow } from '../verb-helpers';
import { responseContract, projectPage } from '../operation-scope';
import { parseBody } from '../verb-helpers';
/**
 * Query-verb family: search, aggregate, export, import. Executors register
 * here and surface through `./registry`.
 *
 * Pipeline mirrors the read-shaped core verbs (`../verbs.ts` `executeList`):
 * filters are parsed, tenant-scoped, and policy-pushed via `scopeListQuery`;
 * every adapter call runs inside `config.adapter.requestScope()`; the returned
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
 * Security boundaries beyond the hono-crud reference:
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
  Page,
  SearchHighlight,
  SearchHit,
  SearchQuery,
} from '../../adapter/query-types';
import { AggregationException, InputValidationException } from '../../envelope/errors';
import { applyComputedFieldsToArray } from '../../model/computed-fields';
import { applyProfileToArray } from '../../model/serialization-profile';
import {
  applyManagedInsertFields,
  applyManagedUpdateFields,
  stripPrimaryKeys,
} from '../../model/managed-fields';
import { assertNoNestedWrites } from '../nested-writes';
import { applyUpsertRestore, isSoftDeleted } from '../../model/soft-delete';
import { filterReadable, maskFields } from '../../policies/evaluate';
import { buildAggregateSpec, computeAggregateFallback } from '../../query/aggregate';
import { parseListFilters } from '../../query/filters';
import { resolveOffsetPagination } from '../../query/pagination';
import {
  generateHighlights,
  parseSearchMode,
  runSearchFallback,
  tokenizeQuery,
  type SearchFieldConfig,
} from '../../query/search';
import { generateCsv, parseCsv } from '../../csv/index';
import type { CrudEndpointName } from '../../verb-table';
import type { EngineRequest, EngineResult } from '../engine-request';
import { envelopeOf } from '../resource';
import {
  assertCreateAllowed,
  assertWriteAllowed,
  buildPolicyContext,
  createSchemaFor,
  listFallbackRows,
  listParseOptions,
  MAX_FALLBACK_SCAN,
  scopeListQuery,
  shapeOne,
  txCtx,
  type AnyResource,
} from '../verb-helpers';
import type { VerbExecutor } from './registry';

type Row = Record<string, unknown>;

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
function parseRequestedFields(
  raw: string | undefined,
  configured: Record<string, unknown>,
): string[] {
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
    options: { ...scoped.options, page: 1, per_page: MAX_FALLBACK_SCAN },
  };

  const adapterSearch = config.adapter.search;
  const hits: Array<SearchHit<Row>> =
    config.adapter.capabilities.has('nativeSearch') && adapterSearch
      ? await config.adapter.requestScope((scope) => adapterSearch(searchQuery, scope), txCtx(req))
      : await config.adapter.requestScope(async (scope) => {
          const rows = await listFallbackRows(resource, scoped, scope);
          return runSearchFallback(rows, searchQuery);
        }, txCtx(req));

  // minScore threshold + read-policy row filtering (hardening vs. hono-crud).
  let matched = hits.filter((hit) => hit.score >= minScore);
  const readable = await filterReadable(
    policyCtx,
    matched.map((h) => h.record),
    resource.model.policies,
  );
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
      if (highlight) {
        const safeHighlights: Record<string, SearchHighlight[]> = {};
        const tokens = tokenizeQuery(term, mode);
        for (const field of hit.matchedFields ?? []) {
          const snippets = generateHighlights(shaped[field], tokens, mode);
          if (snippets.length > 0) safeHighlights[field] = snippets;
        }
        if (Object.keys(safeHighlights).length > 0) item.highlights = safeHighlights;
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
 * native `aggregate` runs it when declared and no row/field policy requires
 * engine evaluation; otherwise the engine computes it over a tenant-scoped,
 * policy-filtered scan capped at 1,000 rows. The
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

  // A profile-excluded field must never be echoed by a response: aggregate
  // group keys and min/max/sum/avg results project field VALUES (unlike
  // filters, which only match rows), so reject the request loudly.
  const excluded = resource.model.serializationProfile?.exclude;
  if (excluded && excluded.length > 0) {
    const referenced = [
      ...(spec.groupBy ?? []),
      ...(spec.aggregations ?? []).map((agg) => agg.field),
    ];
    const blocked = referenced.find((field) => excluded.includes(field));
    if (blocked !== undefined) {
      throw new AggregationException(
        `Field '${blocked}' is excluded by the serialization profile and cannot be aggregated or grouped`,
      );
    }
  }

  const adapterAggregate = config.adapter.aggregate;
  const result = await config.adapter.requestScope(async (scope) => {
    if (
      config.adapter.capabilities.has('aggregate') &&
      adapterAggregate &&
      resource.model.policies?.read === undefined &&
      resource.model.policies?.fields === undefined
    ) {
      return adapterAggregate(spec, scope);
    }
    const rows = await listFallbackRows(resource, scoped, scope);
    const readable = await filterReadable(policyCtx, rows, resource.model.policies);
    const visible = readable.map(
      (row) => maskFields(policyCtx, row, resource.model.policies) as Row,
    );
    return computeAggregateFallback(visible, spec);
  }, txCtx(req));

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

  const rows = await config.adapter.requestScope(async (scope) => {
    // Arbitrary read predicates execute in-process and must use the mandatory
    // 1,000-row authorization window. Export's larger serialization cap must
    // never become an alternate policy-scan path.
    if (model.policies?.read !== undefined) {
      return listFallbackRows(resource, scoped, scope);
    }
    const scan = (await config.adapter.list(
      {
        filters: scoped.filters,
        options: { ...scoped.options, page: 1, per_page: MAX_EXPORT_RECORDS },
      },
      scope,
    )) as Page<Row>;
    return scan.result;
  }, txCtx(req));

  const readable = await filterReadable(policyCtx, rows, model.policies);
  let shaped = await applyComputedFieldsToArray(model, await projectPage(resource, req, readable));
  shaped = shaped.map((row) => maskFields(policyCtx, row, model.policies) as Row);
  shaped = applyProfileToArray(model, shaped);
  shaped = await Promise.all(shaped.map((row) => responseContract(resource, row)));

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
  } else if (
    body !== null &&
    typeof body === 'object' &&
    Array.isArray((body as { items?: unknown }).items)
  ) {
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
  const filters: FilterCondition[] = keys.map((key) => ({
    field: key,
    operator: 'eq',
    value: data[key],
  }));
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
  const policyCtx = buildPolicyContext(req);

  let values: Row;
  try {
    values = await parseBody(createSchema, data);
  } catch (error) {
    if (!(error instanceof InputValidationException)) throw error;
    return {
      rowNumber,
      status: skipInvalid ? 'skipped' : 'failed',
      error: 'Validation failed',
      validationErrors: Array.isArray(error.details)
        ? error.details.filter(
            (issue): issue is { path: string; message: string } =>
              typeof issue === 'object' &&
              issue !== null &&
              typeof issue.path === 'string' &&
              typeof issue.message === 'string',
          )
        : [],
    };
  }
  assertNoNestedWrites(model, values, 'import');
  if (model.tenantField !== undefined && req.vars?.tenantId !== undefined) {
    values[model.tenantField] = req.vars.tenantId;
  }

  try {
    const existing = await findExistingByKeys(resource, req, upsertKeys, values, scope);

    if (mode === 'upsert') {
      if (existing) {
        await assertWriteAllowed(resource, policyCtx, existing);
        const lookup = lookupFromRow(resource, req, existing);
        if (isSoftDeleted(model, existing) && adapter.restore) {
          await adapter.restore(lookup, scope);
        }
        // Body PK (present under id:'client') is insert-leg identity only.
        const patch = applyUpsertRestore(
          model,
          applyManagedUpdateFields(model, stripPrimaryKeys(model, values)),
          existing,
        ) as Row;
        const updated = (await adapter.update(lookup, patch, scope)) as Row | null;
        if (!updated) return { rowNumber, status: 'failed', error: 'Record not found for update' };
        return {
          rowNumber,
          status: 'updated',
          data: await shapeOne(resource, policyCtx, req, updated),
        };
      }
    } else if (existing) {
      return {
        rowNumber,
        status: skipInvalid ? 'skipped' : 'failed',
        error: skipInvalid ? 'Record already exists' : 'Record already exists (duplicate key)',
      };
    }

    const managed = applyManagedInsertFields(model, values, {
      databaseGeneratedId,
      tenantId: req.vars?.tenantId,
    });
    await assertCreateAllowed(resource, policyCtx, managed);
    const created = (await adapter.create(managed, scope)) as Row;
    return {
      rowNumber,
      status: 'created',
      data: await shapeOne(resource, policyCtx, req, created),
    };
  } catch {
    return { rowNumber, status: 'failed', error: 'Import operation failed' };
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

  const summary: ImportSummary = {
    total: rows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  };
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
  }, txCtx(req));

  const status = summary.failed > 0 && summary.failed < summary.total ? 207 : 200;
  return { status, body: envelopeOf(resource).success({ summary, results }) };
}

export const queryVerbExecutors: Partial<Record<CrudEndpointName, VerbExecutor>> = {
  search: executeSearch,
  aggregate: executeAggregate,
  export: executeExport,
  import: executeImport,
};
