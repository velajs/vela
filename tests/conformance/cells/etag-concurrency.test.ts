/**
 * Cell 14 — ETag/If-Match optimistic concurrency.
 *
 * Reconstructed from the hono-crud 0.13 etag-concurrency cell per the port
 * notes: `/etag-items` enables `etag: true` — reads emit a STRONG
 * content-hash `ETag` (quoted 32-hex) and honor `If-None-Match` (304, empty
 * body); updates honor `If-Match` and reject a stale tag with **409
 * CONFLICT** (hono-crud parity — not 412).
 */
import { describe, expect, test } from 'vitest';
import {
  type ConformanceRecord,
  type SuccessEnvelope,
  createRecord,
  expectError,
  jsonInit,
  readJson,
  setupConformance,
} from '../contract';
import { conformanceAdapters } from '../adapters';

const ETAG_SHAPE = /^"[0-9a-f]{32}"$/;

describe.each(conformanceAdapters)('adapter: $name', (descriptor) => {
  const ctx = setupConformance(descriptor);

  const BASE = '/etag-items';

  test('etag concurrency: read emits the tag, If-None-Match 304s, If-Match gates updates', async () => {
    const { app } = ctx();
    const created = await createRecord(app, BASE, {
      name: 'Tagged',
      email: 'tag@conformance.test',
      role: 'user',
      age: 7,
    });

    // Read exposes a strong, quoted content-hash ETag.
    const read = await app.request(`${BASE}/${created.id}`);
    expect(read.status).toBe(200);
    const tag = read.headers.get('ETag');
    expect(tag).toMatch(ETAG_SHAPE);

    // If-None-Match with the current tag → 304 with an EMPTY body.
    const notModified = await app.request(`${BASE}/${created.id}`, {
      headers: { 'If-None-Match': tag as string },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get('ETag')).toBe(tag);
    expect(await notModified.text()).toBe('');

    // A stale If-None-Match still yields the full 200.
    const modified = await app.request(`${BASE}/${created.id}`, {
      headers: { 'If-None-Match': '"0000000000000000000000000000dead"' },
    });
    expect(modified.status).toBe(200);

    // Unconditional update passes and rotates the tag.
    const updated = await app.request(`${BASE}/${created.id}`, jsonInit('PATCH', { age: 8 }));
    expect(updated.status).toBe(200);
    const freshTag = updated.headers.get('ETag');
    expect(freshTag).toMatch(ETAG_SHAPE);
    expect(freshTag).not.toBe(tag);

    // A STALE If-Match is rejected 409 CONFLICT and writes nothing.
    await expectError(
      await app.request(`${BASE}/${created.id}`, {
        ...jsonInit('PATCH', { age: 9 }),
        headers: { 'Content-Type': 'application/json', 'If-Match': tag as string },
      }),
      409,
      'CONFLICT',
    );
    const after = await readJson<SuccessEnvelope<ConformanceRecord>>(
      await app.request(`${BASE}/${created.id}`),
    );
    expect(after.result.age).toBe(8);

    // The CURRENT If-Match passes.
    const conditional = await app.request(`${BASE}/${created.id}`, {
      ...jsonInit('PATCH', { age: 10 }),
      headers: { 'Content-Type': 'application/json', 'If-Match': freshTag as string },
    });
    expect(conditional.status).toBe(200);
  });
});
