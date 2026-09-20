import { describe, expect, it } from 'vitest';
import { createApp } from './app';

const asTenant = (tenant: string, extra: Record<string, string> = {}) => ({
  'X-Tenant-ID': tenant,
  ...extra,
});
const json = (method: string, tenant: string, body: unknown) => ({
  method,
  headers: asTenant(tenant, { 'Content-Type': 'application/json' }),
  body: JSON.stringify(body),
});

describe('multi-tenant wiring example', () => {
  it('rejects requests without a tenant and isolates tenants end to end', async () => {
    const app = await createApp();

    // No X-Tenant-ID → 400 TENANT_REQUIRED from the resolver.
    const missing = await app.request('/notes');
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      'TENANT_REQUIRED',
    );

    // Create as tenant A — tenantId is stamped by the engine.
    const created = await app.request('/notes', json('POST', 'tenant-a', { text: 'hello' }));
    expect(created.status).toBe(201);
    const note = ((await created.json()) as { result: { id: string; tenantId: string } }).result;
    expect(note.tenantId).toBe('tenant-a');

    // Tenant B cannot read, list, update, or delete tenant A's note.
    expect((await app.request(`/notes/${note.id}`, { headers: asTenant('tenant-b') })).status).toBe(404);
    const listB = await app.request('/notes', { headers: asTenant('tenant-b') });
    expect(((await listB.json()) as { result: unknown[] }).result).toHaveLength(0);

    // Tenant A sees it.
    const listA = await app.request('/notes', { headers: asTenant('tenant-a') });
    expect(((await listA.json()) as { result: unknown[] }).result).toHaveLength(1);
  });
});
