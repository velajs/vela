/**
 * Cell 12 — finalize pipeline (serialization profile + computed fields).
 *
 * Reconstructed from the hono-crud 0.13 finalize-pipeline cell per the
 * PARITY.md port notes (the original port was deferred until a
 * `serializationProfile` authoring surface landed): `/profile-items` carries
 * a computed `nameUpper` and `serializationProfile: { exclude: ['age'] }`.
 *
 * Contracts pinned:
 * - every record-returning surface carries `nameUpper` AND omits `age`
 *   (`'age' in record === false`): create/read/list/update, clone/upsert/
 *   restore, batchCreate/batchUpsert, search hits, export (JSON data + CSV
 *   columns), import results;
 * - `age` stays fully WRITABLE and STORED: filtering by `age` matches the
 *   row whose responses never showed it;
 * - `?fields=age` cannot resurrect an excluded field (the strip runs before
 *   field selection).
 */
import { describe, expect, test } from 'vitest';
import {
  type ConformanceApp,
  type ConformanceRecord,
  createRecord,
  expectList,
  expectSuccess,
  jsonInit,
  readJson,
  setupConformance,
} from '../contract';
import { conformanceAdapters } from '../adapters';

type ProfileRecord = ConformanceRecord & { nameUpper?: string };

interface UpsertBody {
  success: boolean;
  result: ProfileRecord;
  created: boolean;
}

describe.each(conformanceAdapters)('adapter: $name', (descriptor) => {
const ctx = setupConformance(descriptor);

const BASE = '/profile-items';

function expectShaped(record: ProfileRecord, name: string): void {
  expect(record.nameUpper).toBe(name.toUpperCase());
  expect('age' in record).toBe(false);
}

async function create(
  app: ConformanceApp,
  name: string,
  email: string,
  age: number,
): Promise<ProfileRecord> {
  return (await createRecord(app, BASE, { name, email, role: 'user', age })) as ProfileRecord;
}

test('finalize pipeline: core five strip the excluded field; it stays writable + stored', async () => {
  const { app } = ctx();

  const created = await create(app, 'Ada', 'ada@conformance.test', 30);
  expectShaped(created, 'Ada');

  const read = await expectSuccess<ProfileRecord>(await app.request(`${BASE}/${created.id}`), 200);
  expectShaped(read, 'Ada');

  const list = await expectList(await app.request(BASE));
  expect(list.result).toHaveLength(1);
  expectShaped(list.result[0] as ProfileRecord, 'Ada');

  // The excluded field stays WRITABLE: the update body carries age...
  const updated = await expectSuccess<ProfileRecord>(
    await app.request(`${BASE}/${created.id}`, jsonInit('PATCH', { age: 44 })),
    200,
  );
  expectShaped(updated, 'Ada');

  // ...and STORED: filtering by the new value matches the row the responses
  // never showed it on.
  const filtered = await expectList(await app.request(`${BASE}?age[gte]=40`));
  expect(filtered.result.map((record) => record.id)).toEqual([created.id]);
  expectShaped(filtered.result[0] as ProfileRecord, 'Ada');

  // ?fields= cannot resurrect an excluded field (strip precedes selection).
  const withFields = await expectSuccess<ProfileRecord>(
    await app.request(`${BASE}/${created.id}?fields=age,name`),
    200,
  );
  expect('age' in withFields).toBe(false);
  expect(withFields.name).toBe('Ada');
});

test('finalize pipeline: clone, upsert (both legs), and restore strip the excluded field', async () => {
  const { app } = ctx();
  const source = await create(app, 'Src', 'src@conformance.test', 21);

  const cloned = await expectSuccess<ProfileRecord>(
    await app.request(`${BASE}/${source.id}/clone`, jsonInit('POST', { email: 'clone@conformance.test' })),
    201,
  );
  expectShaped(cloned, 'Src');

  // Upsert update leg (matches source by email).
  const updateLeg = await app.request(
    `${BASE}/upsert`,
    jsonInit('POST', { name: 'Src2', email: 'src@conformance.test', role: 'user', age: 33 }),
  );
  expect(updateLeg.status).toBe(200);
  const upserted = await readJson<UpsertBody>(updateLeg);
  expect(upserted.created).toBe(false);
  expectShaped(upserted.result, 'Src2');

  // Upsert insert leg.
  const insertLeg = await app.request(
    `${BASE}/upsert`,
    jsonInit('POST', { name: 'New', email: 'new@conformance.test', role: 'user', age: 27 }),
  );
  expect(insertLeg.status).toBe(201);
  const inserted = await readJson<UpsertBody>(insertLeg);
  expect(inserted.created).toBe(true);
  expectShaped(inserted.result, 'New');

  // Soft delete then restore — the revived record is shaped too.
  await app.request(`${BASE}/${source.id}`, { method: 'DELETE' });
  const restored = await expectSuccess<ProfileRecord>(
    await app.request(`${BASE}/${source.id}/restore`, { method: 'POST' }),
    200,
  );
  expectShaped(restored, 'Src2');
});

test('finalize pipeline: batch create/upsert items are stripped', async () => {
  const { app } = ctx();

  const batchRes = await app.request(
    `${BASE}/batch`,
    jsonInit('POST', {
      items: [
        { name: 'B1', email: 'b1@conformance.test', role: 'user', age: 11 },
        { name: 'B2', email: 'b2@conformance.test', role: 'user', age: 12 },
      ],
    }),
  );
  expect(batchRes.status).toBe(201);
  const batch = await readJson<{ result: { created: ProfileRecord[]; count: number } }>(batchRes);
  expect(batch.result.created).toHaveLength(2);
  for (const record of batch.result.created) {
    expectShaped(record, String(record.name));
  }

  const upsertRes = await app.request(
    `${BASE}/batch/upsert`,
    jsonInit('POST', [
      { name: 'B1x', email: 'b1@conformance.test', role: 'user', age: 13 }, // update leg
      { name: 'B3', email: 'b3@conformance.test', role: 'user', age: 14 }, // insert leg
    ]),
  );
  expect(upsertRes.status).toBe(200);
  const upserts = await readJson<{
    result: { items: Array<{ data: ProfileRecord; created: boolean }> };
  }>(upsertRes);
  for (const item of upserts.result.items) {
    expectShaped(item.data, String(item.data.name));
  }
});

test('finalize pipeline: search hits, export legs, and import results are stripped', async () => {
  const { app } = ctx();
  await create(app, 'Findme', 'find@conformance.test', 55);

  const searchRes = await app.request(`${BASE}/search?q=findme`);
  expect(searchRes.status).toBe(200);
  const hits = await readJson<{ result: Array<{ item: ProfileRecord }> }>(searchRes);
  expect(hits.result).toHaveLength(1);
  expectShaped(hits.result[0]!.item, 'Findme');

  const exported = await expectSuccess<{ data: ProfileRecord[]; count: number }>(
    await app.request(`${BASE}/export?format=json`),
    200,
  );
  expect(exported.count).toBe(1);
  expectShaped(exported.data[0]!, 'Findme');

  const csvRes = await app.request(`${BASE}/export?format=csv`);
  expect(csvRes.status).toBe(200);
  const csv = await csvRes.text();
  const header = csv.split('\n')[0] ?? '';
  expect(header).toContain('name');
  expect(header).not.toContain('age');

  const importRes = await app.request(
    `${BASE}/import`,
    jsonInit('POST', { items: [{ name: 'Imp', email: 'imp@conformance.test', role: 'user', age: 61 }] }),
  );
  expect(importRes.status).toBe(200);
  const imported = await readJson<{
    result: { results: Array<{ status: string; data?: ProfileRecord }> };
  }>(importRes);
  expect(imported.result.results[0]!.status).toBe('created');
  // Import results are raw rows + profile strip (import runs without the
  // computed-field enrichment, consistent with its no-per-row-hooks
  // precedent) — the contract here is the strip, not nameUpper.
  expect('age' in imported.result.results[0]!.data!).toBe(false);
  expect(imported.result.results[0]!.data!.name).toBe('Imp');
});
});
