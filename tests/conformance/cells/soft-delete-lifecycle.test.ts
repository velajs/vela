/**
 * Cell 1 — FULL soft-delete lifecycle.
 *
 * The headline contract: a soft-deleted record must 404 on read, update, AND
 * delete-again; default list excludes it, `?withDeleted=true` includes it, and
 * `?onlyDeleted=true` returns only it.
 *
 * Ported from hono-crud tests/conformance/cells/soft-delete-lifecycle.ts. The
 * `restore` verb is NOT yet implemented by the native engine
 * (IMPLEMENTED_ENDPOINTS in packages/core/src/verb-table.ts covers only
 * create/list/read/update/delete), so `POST /items/:id/restore` is never
 * stamped. The delete/hide/list assertions are ported verbatim and RUN; the
 * three restore assertion blocks keep their original test names + assertions
 * All assertions now run — the restore verb landed with M4.
 */
import { describe, expect, test } from 'vitest';
import {
  type ConformanceRecord,
  type SuccessEnvelope,
  createRecord,
  expectError,
  expectList,
  expectSuccess,
  jsonInit,
  readJson,
  setupConformance,
} from '../contract';
import { conformanceAdapters } from '../adapters';

describe.each(conformanceAdapters)('adapter: $name', (descriptor) => {
const ctx = setupConformance(descriptor);

test('soft-delete lifecycle: delete hides record from read/update/delete-again, onlyDeleted lists it', async () => {
  const { app } = ctx();

  const survivor = await createRecord(app, '/items', {
    name: 'Survivor',
    email: 'survivor@conformance.test',
    role: 'user',
    age: 30,
  });
  const victim = await createRecord(app, '/items', {
    name: 'Soft Target',
    email: 'victim@conformance.test',
    role: 'user',
    age: 31,
  });

  // Soft delete → 200 { deleted: true }
  const deleteResponse = await app.request(`/items/${victim.id}`, { method: 'DELETE' });
  expect(deleteResponse.status).toBe(200);
  const deleteBody = await readJson<SuccessEnvelope<{ deleted: boolean }>>(deleteResponse);
  expect(deleteBody.success).toBe(true);
  expect(deleteBody.result.deleted).toBe(true);

  // Read of a soft-deleted record → 404 NOT_FOUND envelope.
  await expectError(await app.request(`/items/${victim.id}`), 404, 'NOT_FOUND');

  // Update of a soft-deleted record → 404 NOT_FOUND envelope.
  await expectError(
    await app.request(`/items/${victim.id}`, jsonInit('PATCH', { name: 'Zombie' })),
    404,
    'NOT_FOUND',
  );

  // Delete-again of a soft-deleted record → 404 NOT_FOUND envelope.
  await expectError(
    await app.request(`/items/${victim.id}`, { method: 'DELETE' }),
    404,
    'NOT_FOUND',
  );

  // Default list excludes the deleted record but keeps the live one.
  const defaultList = await expectList(await app.request('/items'));
  expect(defaultList.result.map((record) => record.id)).toEqual([survivor.id]);

  // ?withDeleted=true (core's softDeleteQueryParam default) includes both.
  const withDeleted = await expectList(await app.request('/items?withDeleted=true'));
  expect(withDeleted.result.map((record) => record.id).sort()).toEqual(
    [survivor.id, victim.id].sort(),
  );

  // ?onlyDeleted=true returns ONLY soft-deleted records.
  const onlyDeleted = await expectList(await app.request('/items?onlyDeleted=true'));
  expect(onlyDeleted.result.map((record) => record.id)).toEqual([victim.id]);
});

// Restore verb landed (M4) — the native engine's optional adapter.restore
// the native engine (verb-table.ts IMPLEMENTED_ENDPOINTS). Assertions preserved
// verbatim; unskip once the restore executor + route stamping land.
test('soft-delete lifecycle: restore revives it', async () => {
  const { app } = ctx();

  const victim = await createRecord(app, '/items', {
    name: 'Soft Target',
    email: 'victim@conformance.test',
    role: 'user',
    age: 31,
  });

  await app.request(`/items/${victim.id}`, { method: 'DELETE' });

  // Restore → 200 with the record, soft-delete marker cleared.
  const restoreResponse = await app.request(`/items/${victim.id}/restore`, {
    method: 'POST',
  });
  const restored = await expectSuccess<ConformanceRecord>(restoreResponse, 200);
  expect(restored.id).toBe(victim.id);
  expect(restored.deletedAt).toBeNull();

  // Read after restore → 200 with the original data intact.
  const reRead = await expectSuccess<ConformanceRecord>(
    await app.request(`/items/${victim.id}`),
    200,
  );
  expect(reRead.id).toBe(victim.id);
  expect(reRead.name).toBe('Soft Target');
  expect(reRead.email).toBe('victim@conformance.test');
});

test('restore of a record that is not soft-deleted → 404 NOT_FOUND', async () => {
  const { app } = ctx();
  const record = await createRecord(app, '/items', {
    name: 'Never Deleted',
    email: 'never-deleted@conformance.test',
    role: 'user',
    age: 25,
  });

  await expectError(
    await app.request(`/items/${record.id}/restore`, { method: 'POST' }),
    404,
    'NOT_FOUND',
  );
});

test('restore of a missing id → 404 NOT_FOUND', async () => {
  const { app } = ctx();
  await expectError(
    await app.request('/items/00000000-0000-4000-8000-000000000999/restore', {
      method: 'POST',
    }),
    404,
    'NOT_FOUND',
  );
});
});
