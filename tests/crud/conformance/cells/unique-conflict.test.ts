/**
 * Cell 13 — unique-constraint conflicts.
 *
 * Reconstructed from the hono-crud 0.13 unique-conflict cell per the port
 * notes (deferred until a unique surface landed): `/unique-items` declares
 * `unique: ['email']` — the memory adapter enforces natively, drizzle via a
 * database UNIQUE index, both surfacing violations as 409 CONFLICT.
 *
 * Contracts pinned:
 * - duplicate create → 409; update colliding with another row → 409;
 * - soft-deleted rows still OCCUPY the slot (recreate after delete → 409 —
 *   non-partial-index semantics, documented on `ModelConfig.unique`);
 * - non-colliding writes still succeed.
 */
import { describe, expect, test } from 'vitest';
import {
  type ConformanceRecord,
  createRecord,
  expectError,
  expectSuccess,
  jsonInit,
  setupConformance,
} from '../contract';
import { conformanceAdapters } from '../adapters';

describe.each(conformanceAdapters)('adapter: $name', (descriptor) => {
  const ctx = setupConformance(descriptor);

  const BASE = '/unique-items';

  test('unique conflict: create and update collisions are 409; free values pass', async () => {
    const { app } = ctx();

    const a = await createRecord(app, BASE, {
      name: 'A',
      email: 'a@conformance.test',
      role: 'user',
      age: 1,
    });
    const b = await createRecord(app, BASE, {
      name: 'B',
      email: 'b@conformance.test',
      role: 'user',
      age: 2,
    });

    // Duplicate create → 409 CONFLICT.
    await expectError(
      await app.request(
        BASE,
        jsonInit('POST', { name: 'Dup', email: 'a@conformance.test', role: 'user', age: 3 }),
      ),
      409,
      'CONFLICT',
    );

    // Update colliding with another row → 409; the row is untouched.
    await expectError(
      await app.request(`${BASE}/${b.id}`, jsonInit('PATCH', { email: 'a@conformance.test' })),
      409,
      'CONFLICT',
    );
    const bStill = await expectSuccess<ConformanceRecord>(
      await app.request(`${BASE}/${b.id}`),
      200,
    );
    expect(bStill.email).toBe('b@conformance.test');

    // A non-colliding update passes; a self-update to the SAME value passes too
    // (the row does not conflict with itself).
    const moved = await expectSuccess<ConformanceRecord>(
      await app.request(`${BASE}/${b.id}`, jsonInit('PATCH', { email: 'c@conformance.test' })),
      200,
    );
    expect(moved.email).toBe('c@conformance.test');
    await expectSuccess<ConformanceRecord>(
      await app.request(`${BASE}/${a.id}`, jsonInit('PATCH', { email: 'a@conformance.test' })),
      200,
    );
  });

  test('unique conflict: soft-deleted rows still occupy the slot', async () => {
    const { app } = ctx();

    const victim = await createRecord(app, BASE, {
      name: 'Victim',
      email: 'held@conformance.test',
      role: 'user',
      age: 4,
    });
    const deleted = await app.request(`${BASE}/${victim.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);

    // Non-partial-index semantics: the tombstone keeps the email taken.
    await expectError(
      await app.request(
        BASE,
        jsonInit('POST', { name: 'Reborn', email: 'held@conformance.test', role: 'user', age: 5 }),
      ),
      409,
      'CONFLICT',
    );
  });
});
