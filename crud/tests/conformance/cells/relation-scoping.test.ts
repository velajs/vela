/**
 * Cell — owner-scoped relation includes (`?include=parent`).
 *
 * The tenant model carries a self-relation (`parent` belongsTo via `parentId`).
 * A parent the caller may not read — another tenant's row, or a soft-deleted
 * one — must be omitted from the include (resolved to `null`). The tenant
 * filter is pushed to the adapter's relation loader via the engine's
 * `RelationLoadScope {tenantField, tenantValue}`.
 *
 * Ported from hono-crud tests/conformance/cells/relation-scoping.ts. The memory
 * leg has `relationScoping: true`, so every assertion runs — including the
 * soft-deleted-parent one, whose PARITY-GAP (engine not forwarding
 * `excludeDeletedField` to the loader) was found by this port and fixed in
 * `attachIncludes` (packages/core/src/kernel/verbs.ts).
 */
import { describe, expect, test } from 'vitest';
import { type ConformanceRecord, createRecord, expectSuccess, setupConformance } from '../contract';
import { conformanceAdapters } from '../adapters';

describe.each(conformanceAdapters)('adapter: $name', (descriptor) => {
  const ctx = setupConformance(descriptor);
  const { headerName, tenantA, tenantB } = descriptor.tenant;
  const asTenant = (tenant: string): Record<string, string> => ({ [headerName]: tenant });

  const readParent = async (childId: string, tenant: string): Promise<unknown> => {
    const result = await expectSuccess<ConformanceRecord>(
      await ctx().app.request(`/tenant-items/${childId}?include=parent`, {
        headers: asTenant(tenant),
      }),
      200,
    );
    return result.parent;
  };

  test('relation include scoping (?include=parent): cross-tenant parents resolve to null', async () => {
    const { app } = ctx();

    // A parent owned by tenant B.
    const parentB = await createRecord(
      app,
      '/tenant-items',
      { name: 'Parent B', email: 'rel-parent-b@conformance.test', role: 'user', age: 40 },
      asTenant(tenantB),
    );

    // A child owned by tenant A pointing at tenant B's parent (cross-tenant FK).
    const childCross = await createRecord(
      app,
      '/tenant-items',
      {
        name: 'Child cross',
        email: 'rel-child-cross@conformance.test',
        role: 'user',
        age: 10,
        parentId: parentB.id,
      },
      asTenant(tenantA),
    );

    // Tenant A's include must NOT expose tenant B's parent.
    expect(await readParent(childCross.id, tenantA)).toBeNull();

    // A same-tenant parent IS embedded.
    const parentA = await createRecord(
      app,
      '/tenant-items',
      { name: 'Parent A', email: 'rel-parent-a@conformance.test', role: 'user', age: 41 },
      asTenant(tenantA),
    );
    const childSame = await createRecord(
      app,
      '/tenant-items',
      {
        name: 'Child same',
        email: 'rel-child-same@conformance.test',
        role: 'user',
        age: 11,
        parentId: parentA.id,
      },
      asTenant(tenantA),
    );
    expect((await readParent(childSame.id, tenantA)) as ConformanceRecord | null).toMatchObject({
      id: parentA.id,
    });
  });

  // PARITY-GAP (fixed): the engine now forwards excludeDeletedField in the
  // RelationLoadScope (parent model's soft-delete config; ?withDeleted lifts it).
  test('relation include scoping (?include=parent): soft-deleted parents resolve to null', async () => {
    const { app } = ctx();

    const parentA = await createRecord(
      app,
      '/tenant-items',
      { name: 'Parent A', email: 'rel-parent-a@conformance.test', role: 'user', age: 41 },
      asTenant(tenantA),
    );
    const childSame = await createRecord(
      app,
      '/tenant-items',
      {
        name: 'Child same',
        email: 'rel-child-same@conformance.test',
        role: 'user',
        age: 11,
        parentId: parentA.id,
      },
      asTenant(tenantA),
    );
    expect((await readParent(childSame.id, tenantA)) as ConformanceRecord | null).toMatchObject({
      id: parentA.id,
    });

    // Soft-delete the parent → now omitted from the include (deletedAt IS NULL).
    await app.request(`/tenant-items/${parentA.id}`, {
      method: 'DELETE',
      headers: asTenant(tenantA),
    });
    expect(await readParent(childSame.id, tenantA)).toBeNull();
  });
});
