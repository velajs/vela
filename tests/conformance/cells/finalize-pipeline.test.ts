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
        { name: 'Bat one', email: 'b1@conformance.test', role: 'user', age: 11 },
        { name: 'Bat two', email: 'b2@conformance.test', role: 'user', age: 12 },
      ],
    }),
  );
  expect(batchRes.status).toBe(201);
  const batch = await readJson<{ result: { created: ProfileRecord[]; count: number } }>(batchRes);
  expect(batch.result.created).toHaveLength(2);
  // Fixed literals — never derive the expected nameUpper from the response.
  const byEmail = new Map(batch.result.created.map((record) => [record.email, record]));
  expectShaped(byEmail.get('b1@conformance.test') as ProfileRecord, 'Bat one');
  expectShaped(byEmail.get('b2@conformance.test') as ProfileRecord, 'Bat two');

  const upsertRes = await app.request(
    `${BASE}/batch/upsert`,
    jsonInit('POST', [
      { name: 'Bat 1x', email: 'b1@conformance.test', role: 'user', age: 13 }, // update leg
      { name: 'Bat three', email: 'b3@conformance.test', role: 'user', age: 14 }, // insert leg
    ]),
  );
  expect(upsertRes.status).toBe(200);
  const upserts = await readJson<{
    result: { items: Array<{ data: ProfileRecord; created: boolean }> };
  }>(upsertRes);
  expectShaped(upserts.result.items[0]!.data, 'Bat 1x');
  expect(upserts.result.items[0]!.created).toBe(false);
  expectShaped(upserts.result.items[1]!.data, 'Bat three');
  expect(upserts.result.items[1]!.created).toBe(true);
});

test('finalize pipeline: same-model embeds are stripped; aggregate rejects excluded fields', async () => {
  const { app } = ctx();
  const parent = await create(app, 'Parent', 'parent@conformance.test', 70);
  const childRes = await app.request(
    BASE,
    jsonInit('POST', {
      name: 'Child',
      email: 'child@conformance.test',
      role: 'user',
      age: 8,
      parentId: parent.id,
    }),
  );
  expect(childRes.status).toBe(201);
  const child = (await readJson<{ result: ProfileRecord }>(childRes)).result;

  // The embedded SAME-model parent row follows the profile (raw loader rows
  // otherwise bypass shaping — cross-model embeds stay a documented gap).
  const withParent = await expectSuccess<ProfileRecord & { parent?: ProfileRecord | null }>(
    await app.request(`${BASE}/${child.id}?include=parent`),
    200,
  );
  expectShaped(withParent, 'Child');
  expect(withParent.parent).toBeTruthy();
  expect('age' in (withParent.parent as ProfileRecord)).toBe(false);

  // Aggregates PROJECT field values (unlike filters, which only match), so
  // referencing an excluded field is a loud 400 — never an echoed value.
  expect((await app.request(`${BASE}/aggregate?count=*&groupBy=age`)).status).toBe(400);
  expect((await app.request(`${BASE}/aggregate?min=age`)).status).toBe(400);
  expect((await app.request(`${BASE}/aggregate?count=*`)).status).toBe(200);
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
