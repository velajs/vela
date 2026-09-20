/**
 * Cell 7 — Multi-tenant scoping on the tenant model variant.
 *
 * Enforcement is engine-owned (create injection + an extra equality filter on
 * read/list/update/delete). The tenant id is resolved by the `multiTenant()`
 * middleware from the `X-Tenant-ID` header and published as the `tenantId`
 * context var the engine scopes on.
 *
 * Ported verbatim (assertions + titles) from hono-crud
 * tests/conformance/cells/tenant-scoping.ts against the native engine's memory
 * descriptor.
 */
import { describe, expect, test } from 'vitest';
import {
  type ConformanceRecord,
  createRecord,
  expectError,
  expectList,
  expectSuccess,
  jsonInit,
  setupConformance,
} from '../contract';
import { conformanceAdapters } from '../adapters';

describe.each(conformanceAdapters)('adapter: $name', (descriptor) => {
  const ctx = setupConformance(descriptor);
  const { field, headerName, tenantA, tenantB } = descriptor.tenant;
  const asTenant = (tenant: string): Record<string, string> => ({ [headerName]: tenant });

  test(`tenant scoping (field: ${field}): tenant A records are invisible to tenant B on read/list/update/delete`, async () => {
    const { app } = ctx();

    const recordA = await createRecord(
      app,
      '/tenant-items',
      { name: 'A Document', email: 'tenant-a@conformance.test', role: 'user', age: 21 },
      asTenant(tenantA),
    );
    // Create injects the tenant discriminator from context.
    expect(recordA[field]).toBe(tenantA);

    const recordB = await createRecord(
      app,
      '/tenant-items',
      { name: 'B Document', email: 'tenant-b@conformance.test', role: 'user', age: 22 },
      asTenant(tenantB),
    );
    expect(recordB[field]).toBe(tenantB);

    // Tenant B cannot read A's record.
    await expectError(
      await app.request(`/tenant-items/${recordA.id}`, { headers: asTenant(tenantB) }),
      404,
      'NOT_FOUND',
    );

    // Tenant B's list contains only B's record.
    const listB = await expectList(
      await app.request('/tenant-items', { headers: asTenant(tenantB) }),
    );
    expect(listB.result.map((record) => record.id)).toEqual([recordB.id]);

    // Tenant B cannot update A's record.
    await expectError(
      await app.request(
        `/tenant-items/${recordA.id}`,
        jsonInit('PATCH', { name: 'Hijacked' }, asTenant(tenantB)),
      ),
      404,
      'NOT_FOUND',
    );

    // Tenant B cannot delete A's record.
    await expectError(
      await app.request(`/tenant-items/${recordA.id}`, {
        method: 'DELETE',
        headers: asTenant(tenantB),
      }),
      404,
      'NOT_FOUND',
    );

    // Tenant A still sees its record, unmodified.
    const reReadA = await expectSuccess<ConformanceRecord>(
      await app.request(`/tenant-items/${recordA.id}`, { headers: asTenant(tenantA) }),
      200,
    );
    expect(reReadA.name).toBe('A Document');

    const listA = await expectList(
      await app.request('/tenant-items', { headers: asTenant(tenantA) }),
    );
    expect(listA.result.map((record) => record.id)).toEqual([recordA.id]);
  });

  test('tenant scoping: request without the tenant header → 400 TENANT_REQUIRED', async () => {
    const { app } = ctx();
    await expectError(await app.request('/tenant-items'), 400, 'TENANT_REQUIRED');
  });
});
