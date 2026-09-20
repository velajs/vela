/**
 * Canned data-browser fixtures: two related models (`user` with soft-delete, and
 * `post` with a foreign key back to `user`) plus a tiny in-memory query engine so
 * `data.listRows`/`data.facets`/`data.readRow` responders actually honor the
 * grid grammar (filters, sort, search, pagination, `withDeleted`). Every value is
 * annotated with a `@velajs/studio-protocol` type, so this module double-guards
 * the wire contract at compile time.
 *
 * The WRITE responders (`data.writeRow`/`deleteRows`/`clearTable`/`generateRows`)
 * simulate the server's M7a behaviour: a destructive op (delete/clear) called
 * without a valid `confirmToken` throws a 428 `STUDIO_CONFIRM_REQUIRED` carrying a
 * single-use {@link StudioConfirmChallenge} on `details`; re-sending the identical
 * args WITH that token succeeds; the token is then spent, so a repeat re-issues a
 * fresh challenge. `generateRows` is clamped at {@link GENERATE_ROWS_MAX}.
 */
import type {
  FacetsRequest,
  FacetsResponse,
  ListRowsRequest,
  StudioColumn,
  StudioConfirmChallenge,
  StudioGridFilter,
  StudioModelDescriptor,
  StudioModelInfo,
  StudioRowPage,
} from '@velajs/studio-protocol';
import type { FakeTransportTable } from './fake-transport';
import { FakeAdminError, makeErrorBody } from './fake-transport';

type Row = Record<string, unknown>;

const HOUR = 3_600_000;
const BASE_TS = 1_700_000_000_000;

const ROLES = ['admin', 'member', 'viewer'] as const;

/** 60 deterministic user rows — enough to exercise grid virtualization. */
function makeUsers(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 60; i += 1) {
    const n = String(i).padStart(3, '0');
    // A handful are soft-deleted so `withDeleted` has a visible effect.
    const deleted = i % 17 === 0 && i !== 0;
    rows.push({
      id: `u_${n}`,
      email: `user${n}@example.com`,
      name: `User ${n}`,
      role: ROLES[i % ROLES.length],
      active: i % 4 !== 0,
      createdAt: BASE_TS + i * HOUR,
      deletedAt: deleted ? BASE_TS + i * HOUR + HOUR : null,
    });
  }
  return rows;
}

/** 12 post rows, each authored by one of the first users (FK pair). */
function makePosts(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 12; i += 1) {
    const n = String(i).padStart(2, '0');
    rows.push({
      id: `p_${n}`,
      title: `Post ${n}: ${i % 2 === 0 ? 'Release notes' : 'Design log'}`,
      authorId: `u_${String(i % 6).padStart(3, '0')}`,
      published: i % 3 !== 0,
      views: i * 137,
      createdAt: BASE_TS + i * HOUR * 2,
    });
  }
  return rows;
}

const col = (
  name: string,
  type: StudioColumn['type'],
  extra: Partial<StudioColumn> = {},
): StudioColumn => ({
  name,
  type,
  pk: false,
  nullable: false,
  unique: false,
  managed: false,
  ...extra,
});

/** The `user` model descriptor — soft-delete + facet/search/cascade capable. */
export const userDescriptor: StudioModelDescriptor = {
  name: 'user',
  table: 'users',
  primaryKeys: ['id'],
  columns: [
    col('id', 'string', { pk: true, unique: true }),
    col('email', 'string', { unique: true }),
    col('name', 'string'),
    col('role', 'string'),
    col('active', 'boolean'),
    col('createdAt', 'date', { managed: true }),
    col('deletedAt', 'date', { nullable: true, managed: true }),
  ],
  relations: [
    { name: 'posts', type: 'hasMany', target: 'post', foreignKey: 'authorId', cascade: 'setNull' },
  ],
  flags: { softDelete: true, multiTenant: false, versioning: false, audit: true },
  supports: { bulkWrites: true, facets: true, search: true, cascade: true },
};

/** The `post` model descriptor — FK back to `user`, no soft-delete. */
export const postDescriptor: StudioModelDescriptor = {
  name: 'post',
  table: 'posts',
  primaryKeys: ['id'],
  columns: [
    col('id', 'string', { pk: true, unique: true }),
    col('title', 'string'),
    col('authorId', 'string', { fk: { table: 'users', relation: 'author' } }),
    col('published', 'boolean'),
    col('views', 'number'),
    col('createdAt', 'date', { managed: true }),
  ],
  relations: [{ name: 'author', type: 'belongsTo', target: 'user', foreignKey: 'authorId' }],
  flags: { softDelete: false, multiTenant: false, versioning: false, audit: false },
  supports: { bulkWrites: true, facets: true, search: true, cascade: false },
};

/** The model listing (`data.listModels`). */
export const dataModels: StudioModelInfo[] = [
  {
    name: 'user',
    table: 'users',
    label: 'Users',
    capabilities: ['search', 'aggregate', 'cascade'],
  },
  { name: 'post', table: 'posts', label: 'Posts', capabilities: ['search', 'aggregate'] },
];

const DESCRIPTORS: Record<string, StudioModelDescriptor> = {
  user: userDescriptor,
  post: postDescriptor,
};

const DATASET: Record<string, Row[]> = {
  user: makeUsers(),
  post: makePosts(),
};

/** Descriptor lookup used by responders and tests. */
export function describeDataModel(model: string): StudioModelDescriptor {
  const descriptor = DESCRIPTORS[model];
  if (descriptor === undefined) throw new Error(`unknown fixture model "${model}"`);
  return descriptor;
}

/**
 * A model's full row set as a fresh array (for assertions / cross-model
 * fixtures). The query engine only ever filters/sorts/slices — it never mutates
 * a row — so the shared row objects are safe to hand back by reference.
 */
export function dataRows(model: string): Row[] {
  return (DATASET[model] ?? []).slice();
}

// ---- in-memory query engine ------------------------------------------------

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function matchesFilter(row: Row, filter: StudioGridFilter): boolean {
  const actual = row[filter.field];
  const expected = filter.value;
  switch (filter.operator) {
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== expected;
    case 'gt':
      return compare(actual, expected) > 0;
    case 'gte':
      return compare(actual, expected) >= 0;
    case 'lt':
      return compare(actual, expected) < 0;
    case 'lte':
      return compare(actual, expected) <= 0;
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    case 'nin':
      return Array.isArray(expected) && !expected.includes(actual);
    case 'like':
      return String(actual).includes(String(expected));
    case 'ilike':
      return String(actual).toLowerCase().includes(String(expected).toLowerCase());
    case 'null':
      return expected === true
        ? actual === null || actual === undefined
        : actual !== null && actual !== undefined;
    case 'between': {
      if (!Array.isArray(expected) || expected.length !== 2) return false;
      const n = asNumber(actual);
      return n >= asNumber(expected[0]) && n <= asNumber(expected[1]);
    }
    default:
      return true;
  }
}

function matchesSearch(row: Row, search: string): boolean {
  const needle = search.toLowerCase();
  return Object.values(row).some(
    (value) => typeof value === 'string' && value.toLowerCase().includes(needle),
  );
}

/** Run a `ListRowsRequest` against the canned dataset, honoring the grid grammar. */
export function queryRows(request: ListRowsRequest): StudioRowPage {
  const descriptor = describeDataModel(request.model);
  let rows = dataRows(request.model);

  if (descriptor.flags.softDelete && request.withDeleted !== true) {
    rows = rows.filter((row) => row.deletedAt === null || row.deletedAt === undefined);
  }
  for (const filter of request.filters ?? []) {
    rows = rows.filter((row) => matchesFilter(row, filter));
  }
  if (request.search !== undefined && request.search !== '') {
    rows = rows.filter((row) => matchesSearch(row, request.search ?? ''));
  }
  if (request.sort !== undefined) {
    const { field, order } = request.sort;
    const dir = order === 'desc' ? -1 : 1;
    rows = rows.toSorted((a, b) => compare(a[field], b[field]) * dir);
  }

  const total = rows.length;
  const perPage = request.perPage ?? 25;
  const page = request.page ?? 1;
  const start = (page - 1) * perPage;
  const pageRows = rows.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(total / perPage));

  return {
    rows: pageRows,
    info: {
      page,
      per_page: perPage,
      total_count: total,
      total_pages: totalPages,
      has_next_page: page < totalPages,
      has_prev_page: page > 1,
    },
  };
}

/** Faceted counts for a low-cardinality field (`data.facets`). */
export function facetRows(request: FacetsRequest): FacetsResponse {
  let rows = dataRows(request.model);
  for (const filter of request.filters ?? []) {
    rows = rows.filter((row) => matchesFilter(row, filter));
  }
  const counts = new Map<unknown, number>();
  for (const row of rows) {
    const value = row[request.field];
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const buckets = [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .toSorted((a, b) => b.count - a.count)
    .slice(0, request.limit ?? 20);
  return { buckets };
}

/** Read a single row by id (`data.readRow`). */
export function readDataRow(model: string, id: string): Row | null {
  return dataRows(model).find((row) => row.id === id) ?? null;
}

// ---- write responders + the 428 confirm challenge --------------------------

/** The server clamps `data.generateRows` at this many rows per call. */
export const GENERATE_ROWS_MAX = 1000;

/**
 * A single-use confirm-token ledger. `issue` mints a fresh valid token for a
 * human `summary` as a {@link StudioConfirmChallenge} — the canonical protocol
 * shape the real server puts on a 428 `details` — and `consume` spends a token
 * exactly once (an unknown, empty, or already-spent token is rejected, forcing a
 * fresh challenge). This is the generic destructive-confirm behaviour M7b drives;
 * M8b's `timeTravel.*` destructive ops reuse the same ledger contract.
 */
export interface ConfirmStore {
  issue(summary: string): StudioConfirmChallenge;
  consume(token: string | undefined): boolean;
}

export function makeConfirmStore(prefix = 'confirm'): ConfirmStore {
  const valid = new Set<string>();
  let counter = 0;
  return {
    issue(summary) {
      counter += 1;
      const confirmToken = `${prefix}_${counter}`;
      valid.add(confirmToken);
      // A fixed +5m window (epoch-ms, per the protocol) keeps this deterministic.
      return { confirmToken, expiresAt: BASE_TS + 300_000, summary };
    },
    consume(token) {
      if (token === undefined || token === '' || !valid.has(token)) return false;
      valid.delete(token);
      return true;
    },
  };
}

export function confirmRequired(challenge: StudioConfirmChallenge): FakeAdminError {
  return new FakeAdminError(
    makeErrorBody('STUDIO_CONFIRM_REQUIRED', 428, {
      title: 'Confirmation required',
      message: 'This destructive action requires confirmation.',
      details: challenge,
    }),
  );
}

/**
 * The `data.*` responders, wired over the in-memory engine. Read responders are
 * pure; the write responders share a fresh {@link ConfirmStore} per call, so
 * each `fakeTable()` (one per test) gets an isolated single-use token ledger.
 */
export function dataResponders(): FakeTransportTable {
  const confirmStore = makeConfirmStore();
  let created = 0;
  return {
    'data.listModels': dataModels,
    'data.describeModel': (args) => describeDataModel(args.model),
    'data.listRows': (args) => queryRows(args),
    'data.facets': (args) => facetRows(args),
    'data.readRow': (args) => readDataRow(args.model, args.id),
    'data.writeRow': (args) => {
      // Validate the model (unknown → throws, mirroring the server 404).
      describeDataModel(args.model);
      if (args.id === undefined) {
        created += 1;
        return { id: `${args.model}_new_${created}`, ...args.patch };
      }
      return { id: args.id, ...args.patch };
    },
    'data.deleteRows': (args) => {
      if (!confirmStore.consume(args.confirmToken)) {
        throw confirmRequired(
          confirmStore.issue(`${args.mode}-delete ${args.ids.length} rows from ${args.model}`),
        );
      }
      return { deleted: args.ids.length };
    },
    'data.clearTable': (args) => {
      if (!confirmStore.consume(args.confirmToken)) {
        const total = dataRows(args.model).length;
        throw confirmRequired(confirmStore.issue(`clear all ${total} rows from ${args.model}`));
      }
      return { deleted: dataRows(args.model).length };
    },
    'data.generateRows': (args) => {
      if (args.count > GENERATE_ROWS_MAX) {
        throw new FakeAdminError(
          makeErrorBody('STUDIO_BAD_REQUEST', 400, {
            title: 'Too many rows',
            message: `Cannot generate ${args.count} rows in one call.`,
            hint: `Maximum ${GENERATE_ROWS_MAX} rows per generate; requested ${args.count}.`,
          }),
        );
      }
      return { inserted: args.count };
    },
  };
}
