/**
 * Smoke test for the multi-tenant wiring example. Verifies that:
 *   - A request without `X-Tenant-ID` is rejected by `multiTenant()` (400).
 *   - A request with `X-Tenant-ID` flows through, tenant filter pushdown
 *     applies, and per-tenant data is isolated end-to-end.
 *   - Removing `tenantResolverMounted: true` throws `MissingTenantResolverError`
 *     synchronously at module-load time.
 */
import { CrudModule, MissingTenantResolverError } from '@velajs/crud';
import { defineMeta, defineModel } from 'hono-crud';
import { z } from 'zod';
import { createMultiTenantApp } from './app.js';

async function readJson(res: Response): Promise<unknown> {
  return res.status === 204 ? null : res.json();
}

const { app, hono } = await createMultiTenantApp();

// 1. Missing tenant header → multiTenant() rejects with 400.
const noTenant = await hono.request('/tasks', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: '1', title: 'no tenant set' }),
});
console.log('without tenant header:', noTenant.status, await readJson(noTenant));

// 2. Tenant header present → create + list scoped to that tenant.
const tenantA = { 'content-type': 'application/json', 'x-tenant-id': 'tenant-A' };
await hono.request('/tasks', {
  method: 'POST',
  headers: tenantA,
  body: JSON.stringify({ id: '1', title: 'first task' }),
});
const tenantB = { 'content-type': 'application/json', 'x-tenant-id': 'tenant-B' };
await hono.request('/tasks', {
  method: 'POST',
  headers: tenantB,
  body: JSON.stringify({ id: '2', title: 'other tenant' }),
});
const listA = await hono.request('/tasks', { headers: tenantA });
console.log('tenant-A list:', listA.status, await readJson(listA));
const listB = await hono.request('/tasks', { headers: tenantB });
console.log('tenant-B list:', listB.status, await readJson(listB));

// 3. Demonstrate the fail-fast contract: omitting `tenantResolverMounted`
//    on a tenant-scoped Model throws synchronously.
const Schema = z.object({ id: z.string(), tenantId: z.string() });
const Model = defineModel({
  tableName: 'demo_tenant_scoped',
  schema: Schema,
  primaryKeys: ['id'],
  multiTenant: true,
});
const meta = defineMeta({ model: Model });
try {
  CrudModule.forResource('/demo', { meta, adapters: {} as never });
  console.log('UNEXPECTED: no throw');
} catch (e) {
  if (e instanceof MissingTenantResolverError) {
    console.log('fail-fast caught:', e.name, '@', e.mountPath, 'table=', e.tableName);
  } else {
    throw e;
  }
}

await app.close('smoke');
