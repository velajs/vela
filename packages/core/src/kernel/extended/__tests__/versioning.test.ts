import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AdapterCapability, AdapterScope, CrudAdapter } from '../../../adapter/contract';
import type { ListQuery, Lookup, Page } from '../../../adapter/query-types';
import { defineModel } from '../../../model/define-model';
import { defineResource } from '../../resource';
import type { EngineRequest } from '../../engine-request';
import { MemoryVersioningStore, type VersionEntry } from '../../../versioning/index';
import { MemoryAuditStore } from '../../../audit/index';

type Row = Record<string, unknown>;

/**
 * In-test adapter over a Map — the versioning/audit sibling of the one in
 * `./restore-clone-upsert.test.ts`. Rows are records; the version/audit stores
 * are the separate DI seams the engine writes to.
 */
function fakeAdapter(store: Map<string, Row>, softDeleteField?: string): CrudAdapter<Row> {
  const scopeSentinel: AdapterScope = { tx: { fake: true } };
  const visible = (row: Row, withDeleted: boolean) =>
    withDeleted || softDeleteField === undefined || row[softDeleteField] == null;
  const find = (lookup: Lookup, withDeleted: boolean): Row | null => {
    for (const row of store.values()) {
      if (String(row[lookup.field]) !== lookup.value) continue;
      const extras = Object.entries(lookup.filters ?? {});
      if (!extras.every(([k, v]) => String(row[k]) === v)) return null;
      return visible(row, withDeleted) ? row : null;
    }
    return null;
  };

  const caps: AdapterCapability[] = [];
  if (softDeleteField !== undefined) caps.push('softDelete');

  return {
    capabilities: new Set(caps),
    async transaction(fn) {
      return fn(scopeSentinel);
    },
    async create(input) {
      const row = { ...input } as Row;
      store.set(String(row.id), row);
      return row;
    },
    async readOne(lookup, optsRead) {
      return find(lookup, optsRead.withDeleted ?? false);
    },
    async update(lookup, patch) {
      const existing = find(lookup, false);
      if (!existing) return null;
      const updated = { ...existing, ...patch };
      store.set(String(existing.id), updated);
      return updated;
    },
    async delete(lookup, optsDelete) {
      const existing = find(lookup, false);
      if (!existing) return null;
      if (optsDelete.softDeleteField !== undefined) {
        const stamped = { ...existing, [optsDelete.softDeleteField]: Date.now() };
        store.set(String(existing.id), stamped);
        return stamped;
      }
      store.delete(String(existing.id));
      return existing;
    },
    async list(query: ListQuery): Promise<Page<Row>> {
      let rows = Array.from(store.values());
      if (softDeleteField !== undefined && !query.options.withDeleted) {
        rows = rows.filter((r) => r[softDeleteField] == null);
      }
      for (const f of query.filters) rows = rows.filter((r) => String(r[f.field]) === String(f.value));
      const page = query.options.page ?? 1;
      const perPage = query.options.per_page ?? 20;
      const slice = rows.slice((page - 1) * perPage, page * perPage);
      return {
        result: slice,
        result_info: {
          page,
          per_page: perPage,
          total_count: rows.length,
          total_pages: Math.ceil(rows.length / perPage),
          has_next_page: page * perPage < rows.length,
          has_prev_page: page > 1,
        },
      };
    },
  };
}

const docSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string().optional(),
  tenantId: z.string().optional(),
  version: z.number().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  deletedAt: z.number().nullable().optional(),
});

interface MakeOpts {
  versioning?: boolean;
  audit?: boolean;
  multiTenant?: boolean;
  softDelete?: boolean;
  versioningStore?: MemoryVersioningStore;
  auditStore?: MemoryAuditStore;
}

function makeResource(opts: MakeOpts = {}) {
  const store = new Map<string, Row>();
  const model = defineModel({
    name: 'doc',
    tableName: 'documents',
    schema: docSchema,
    softDelete: opts.softDelete ?? false,
    multiTenant: opts.multiTenant ?? false,
    versioning: opts.versioning ?? false,
    audit: opts.audit ?? false,
  });
  const adapter = fakeAdapter(store, opts.softDelete ? 'deletedAt' : undefined);
  const resource = defineResource('doc', {
    model,
    adapter,
    filterFields: ['title'],
    ...(opts.versioningStore ? { versioningStore: opts.versioningStore } : {}),
    ...(opts.auditStore ? { auditStore: opts.auditStore } : {}),
  });
  return { store, model, adapter, resource };
}

const req = (partial: Partial<EngineRequest> = {}): EngineRequest => partial;

function seedHistory(vstore: MemoryVersioningStore, recordId: string, upTo: number): void {
  for (let i = 1; i <= upTo; i++) {
    const entry: VersionEntry = {
      id: `entry-${i}`,
      recordId,
      version: i,
      data: { id: recordId, title: `Title v${i}`, content: `Content v${i}`, version: i },
      createdAt: new Date(Date.now() - (upTo - i) * 1000),
    };
    void vstore.save('documents', entry);
  }
}

// ===========================================================================
// Definition-time loud errors
// ===========================================================================

describe('definition-time store requirements', () => {
  it('throws when model.versioning is on but no versioningStore is provided', () => {
    expect(() => makeResource({ versioning: true })).toThrow(/versioningStore/);
  });

  it('throws when model.audit is on but no auditStore is provided', () => {
    expect(() => makeResource({ audit: true })).toThrow(/auditStore/);
  });

  it('compiles cleanly when the stores are provided', () => {
    expect(() =>
      makeResource({
        versioning: true,
        audit: true,
        versioningStore: new MemoryVersioningStore(),
        auditStore: new MemoryAuditStore(),
      }),
    ).not.toThrow();
  });
});

// ===========================================================================
// Version snapshot capture (update / delete)
// ===========================================================================

describe('version snapshot capture', () => {
  it('snapshots the PRE-update state and increments the row version on update', async () => {
    const vstore = new MemoryVersioningStore();
    const { resource, store } = makeResource({ versioning: true, versioningStore: vstore });
    store.set('d1', { id: 'd1', title: 'Original', content: 'Body', version: 1 });

    const result = await resource.execute('update', req({ id: 'd1', body: { title: 'Updated' } }));
    expect(result.status).toBe(200);
    expect((result.body as { result: Row }).result.version).toBe(2);
    expect(store.get('d1')!.title).toBe('Updated');

    const versions = await vstore.list('documents', 'd1');
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1); // the version BEFORE the update
    expect(versions[0].data.title).toBe('Original'); // pre-update snapshot
  });

  it('records changedBy from the request user id', async () => {
    const vstore = new MemoryVersioningStore();
    const { resource, store } = makeResource({ versioning: true, versioningStore: vstore });
    store.set('d1', { id: 'd1', title: 'Original', version: 1 });

    await resource.execute('update', req({ id: 'd1', body: { title: 'New' }, vars: { userId: 'u-9' } }));
    const versions = await vstore.list('documents', 'd1');
    expect(versions[0].changedBy).toBe('u-9');
  });

  it('snapshots the pre-delete state on delete (native hardening beyond hono-crud)', async () => {
    const vstore = new MemoryVersioningStore();
    const { resource, store } = makeResource({ versioning: true, versioningStore: vstore });
    store.set('d1', { id: 'd1', title: 'Doomed', version: 2 });

    await resource.execute('delete', req({ id: 'd1' }));
    const versions = await vstore.list('documents', 'd1');
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(2);
    expect(versions[0].data.title).toBe('Doomed');
  });

  it('does not snapshot when the model does not version', async () => {
    const vstore = new MemoryVersioningStore();
    // versioning off → no store required, none consulted.
    const { resource, store } = makeResource({});
    store.set('d1', { id: 'd1', title: 'Original', version: 1 });
    await resource.execute('update', req({ id: 'd1', body: { title: 'Updated' } }));
    expect(vstore.all()).toHaveLength(0);
  });
});

// ===========================================================================
// Version verbs: history / read / compare / rollback
// ===========================================================================

describe('version verbs', () => {
  function versionedFixture() {
    const vstore = new MemoryVersioningStore();
    const { resource, store } = makeResource({ versioning: true, versioningStore: vstore });
    store.set('d1', { id: 'd1', title: 'Current Title', content: 'Current', version: 3 });
    seedHistory(vstore, 'd1', 3);
    return { resource, store, vstore };
  }

  it('versionHistory → 200 with newest-first versions + totalVersions', async () => {
    const { resource } = versionedFixture();
    const result = await resource.execute('versionHistory', req({ id: 'd1' }));
    expect(result.status).toBe(200);
    const body = result.body as { result: { versions: VersionEntry[]; totalVersions: number } };
    expect(body.result.versions).toHaveLength(3);
    expect(body.result.versions[0].version).toBe(3); // newest first
    expect(body.result.totalVersions).toBe(3);
  });

  it('versionHistory honors ?limit / ?offset', async () => {
    const { resource } = versionedFixture();
    const result = await resource.execute(
      'versionHistory',
      req({ id: 'd1', query: { limit: '2', offset: '1' } }),
    );
    const body = result.body as { result: { versions: VersionEntry[] } };
    expect(body.result.versions).toHaveLength(2);
    expect(body.result.versions[0].version).toBe(2);
  });

  it('versionRead → 200 with the requested version snapshot', async () => {
    const { resource } = versionedFixture();
    const result = await resource.execute('versionRead', req({ id: 'd1', params: { version: '2' } }));
    expect(result.status).toBe(200);
    const body = result.body as { result: VersionEntry };
    expect(body.result.version).toBe(2);
    expect((body.result.data as Row).title).toBe('Title v2');
  });

  it('versionRead → 404 for a non-existent version', async () => {
    const { resource } = versionedFixture();
    await expect(
      resource.execute('versionRead', req({ id: 'd1', params: { version: '99' } })),
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('versionRead → 400 for a non-positive-integer version', async () => {
    const { resource } = versionedFixture();
    await expect(
      resource.execute('versionRead', req({ id: 'd1', params: { version: 'abc' } })),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
  });

  it('versionCompare → 200 with from/to/changes', async () => {
    const { resource } = versionedFixture();
    const result = await resource.execute(
      'versionCompare',
      req({ id: 'd1', query: { from: '1', to: '2' } }),
    );
    expect(result.status).toBe(200);
    const body = result.body as { result: { from: number; to: number; changes: unknown[] } };
    expect(body.result.from).toBe(1);
    expect(body.result.to).toBe(2);
    expect(body.result.changes.length).toBeGreaterThan(0);
  });

  it('versionCompare → changes: [] (no 404) when a version is missing', async () => {
    const { resource } = versionedFixture();
    const result = await resource.execute(
      'versionCompare',
      req({ id: 'd1', query: { from: '1', to: '99' } }),
    );
    expect(result.status).toBe(200);
    expect((result.body as { result: { changes: unknown[] } }).result.changes).toEqual([]);
  });

  it('versionCompare → 400 when a param is missing/invalid', async () => {
    const { resource } = versionedFixture();
    await expect(
      resource.execute('versionCompare', req({ id: 'd1', query: { from: '1' } })),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
  });

  it('versionRollback → 200, writes the historical data back with version=current+1', async () => {
    const { resource, store, vstore } = versionedFixture();
    const result = await resource.execute(
      'versionRollback',
      req({ id: 'd1', params: { version: '1' } }),
    );
    expect(result.status).toBe(200);
    const body = result.body as { result: Row };
    expect(body.result.title).toBe('Title v1');
    expect(body.result.version).toBe(4); // currentVersion (3) + 1

    // Persisted back to the row.
    expect(store.get('d1')!.title).toBe('Title v1');
    expect(store.get('d1')!.version).toBe(4);

    // Pre-rollback state was snapshotted (native hardening).
    const preRollback = (await vstore.list('documents', 'd1')).find(
      (e) => (e.data as Row).title === 'Current Title',
    );
    expect(preRollback).toBeDefined();
  });

  it('versionRollback → 404 for a non-existent version', async () => {
    const { resource } = versionedFixture();
    await expect(
      resource.execute('versionRollback', req({ id: 'd1', params: { version: '99' } })),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('version verbs throw a loud ConfigurationException when versioning is not enabled', async () => {
    const { resource } = makeResource({});
    await expect(
      resource.execute('versionHistory', req({ id: 'd1' })),
    ).rejects.toMatchObject({ statusCode: 500, code: 'CONFIGURATION_ERROR' });
  });
});

// ===========================================================================
// Serialization-profile interplay
// ===========================================================================

describe('serialization profile interplay', () => {
  it('snapshots retain excluded fields; rollback (a live record) strips them', async () => {
    const vstore = new MemoryVersioningStore();
    const store = new Map<string, Row>();
    const model = defineModel({
      name: 'doc',
      tableName: 'documents',
      schema: docSchema,
      versioning: true,
      serializationProfile: { exclude: ['content'] },
    });
    const resource = defineResource('doc', {
      model,
      adapter: fakeAdapter(store),
      versioningStore: vstore,
    });
    store.set('d1', { id: 'd1', title: 'Original', content: 'Secret body', version: 1 });

    // The update RESPONSE is stripped, but the pre-update SNAPSHOT keeps the
    // excluded field — version data is the audit trail, not a response body.
    const updated = await resource.execute('update', req({ id: 'd1', body: { title: 'Updated' } }));
    expect('content' in (updated.body as { result: Row }).result).toBe(false);
    const versions = await vstore.list('documents', 'd1');
    expect(versions[0]!.data.content).toBe('Secret body');

    // versionHistory returns snapshots verbatim (excluded field retained).
    const history = await resource.execute('versionHistory', req({ id: 'd1' }));
    const entries = (history.body as { result: { versions: VersionEntry[] } }).result.versions;
    expect(entries[0]!.data.content).toBe('Secret body');

    // versionRollback returns the LIVE record — shaped, so the field strips
    // from the response while the storage row gets it back.
    const rolled = await resource.execute(
      'versionRollback',
      req({ id: 'd1', params: { version: '1' } }),
    );
    expect(rolled.status).toBe(200);
    expect('content' in (rolled.body as { result: Row }).result).toBe(false);
    expect(store.get('d1')!.content).toBe('Secret body');
  });
});

// ===========================================================================
// Tenant / owner scoping
// ===========================================================================

describe('version verbs — tenant/owner scope', () => {
  function tenantFixture() {
    const vstore = new MemoryVersioningStore();
    const { resource, store } = makeResource({
      versioning: true,
      multiTenant: true,
      versioningStore: vstore,
    });
    store.set('d1', { id: 'd1', title: 'A doc', tenantId: 't1', version: 2 });
    seedHistory(vstore, 'd1', 2);
    return { resource, store, vstore };
  }

  it('owner tenant sees history; another tenant gets 404', async () => {
    const { resource } = tenantFixture();
    const owner = await resource.execute('versionHistory', req({ id: 'd1', vars: { tenantId: 't1' } }));
    expect(owner.status).toBe(200);

    await expect(
      resource.execute('versionHistory', req({ id: 'd1', vars: { tenantId: 't2' } })),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('read / rollback are owner-scoped (404 for another tenant)', async () => {
    const { resource } = tenantFixture();
    await expect(
      resource.execute('versionRead', req({ id: 'd1', params: { version: '1' }, vars: { tenantId: 't2' } })),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      resource.execute('versionRollback', req({ id: 'd1', params: { version: '1' }, vars: { tenantId: 't2' } })),
    ).rejects.toMatchObject({ statusCode: 404 });

    // Owner still succeeds.
    const ok = await resource.execute(
      'versionRead',
      req({ id: 'd1', params: { version: '1' }, vars: { tenantId: 't1' } }),
    );
    expect(ok.status).toBe(200);
  });
});

// ===========================================================================
// Audit capture
// ===========================================================================

describe('audit capture', () => {
  it('logs a create entry with the record and user id', async () => {
    const astore = new MemoryAuditStore();
    const { resource } = makeResource({ audit: true, auditStore: astore });
    await resource.execute('create', req({ body: { title: 'Hello' }, vars: { userId: 'u-1' } }));

    const logs = astore.all();
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('create');
    expect(logs[0].tableName).toBe('documents');
    expect(logs[0].userId).toBe('u-1');
    expect((logs[0].record as Row).title).toBe('Hello');
  });

  it('logs an update entry with previous/new records + field changes', async () => {
    const astore = new MemoryAuditStore();
    const { resource, store } = makeResource({ audit: true, auditStore: astore });
    store.set('d1', { id: 'd1', title: 'Old', version: 1 });

    await resource.execute('update', req({ id: 'd1', body: { title: 'New' }, vars: { userId: 'u-2' } }));

    const logs = await astore.query({ action: 'update' });
    expect(logs).toHaveLength(1);
    expect((logs[0].previousRecord as Row).title).toBe('Old');
    expect((logs[0].record as Row).title).toBe('New');
    expect(logs[0].changes).toContainEqual({ field: 'title', oldValue: 'Old', newValue: 'New' });
  });

  it('logs a delete entry with the pre-delete snapshot', async () => {
    const astore = new MemoryAuditStore();
    const { resource, store } = makeResource({ audit: true, auditStore: astore });
    store.set('d1', { id: 'd1', title: 'Gone', version: 1 });

    await resource.execute('delete', req({ id: 'd1' }));
    const logs = await astore.query({ action: 'delete' });
    expect(logs).toHaveLength(1);
    expect((logs[0].previousRecord as Row).title).toBe('Gone');
  });

  it('logs a batch mutation via logBatch (one entry per item)', async () => {
    const astore = new MemoryAuditStore();
    const { resource } = makeResource({ audit: true, auditStore: astore });

    await resource.execute(
      'batchCreate',
      req({ body: { items: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] } }),
    );

    const logs = await astore.query({ action: 'batch_create' });
    expect(logs).toHaveLength(3);
    expect(logs.map((l) => (l.record as Row).title).sort()).toEqual(['a', 'b', 'c']);
  });

  it('does not audit when the model does not enable audit', async () => {
    const astore = new MemoryAuditStore();
    const { resource } = makeResource({});
    await resource.execute('create', req({ body: { title: 'Silent' } }));
    expect(astore.all()).toHaveLength(0);
  });
});
