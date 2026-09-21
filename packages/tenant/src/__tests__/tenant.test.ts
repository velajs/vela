import { describe, it, expect } from 'vitest';
import {
  MemoryTenantRegistryStore,
  TenantRegistry,
  TenantService,
  TenantError,
  type TenantContextReader,
  type TenantRecord,
} from '../index';
const principal = { issuer: 'test', subject: 'user', principalType: 'user' } as const;
const row = (id: string): TenantRecord => ({
  id,
  name: id,
  status: 'active',
  revision: 1,
  settings: { nested: { value: 1 } },
});
describe('tenant authority', () => {
  it('isolates concurrent operations and environments and revokes retained scopes', async () => {
    const store = new MemoryTenantRegistryStore([row('a'), row('b')]);
    const service = new TenantService({ lookup: store, authorize: () => true });
    let retained: TenantContextReader | undefined;
    expect(
      await Promise.all(
        ['a', 'b'].map((tenantId) =>
          service.run({ tenantId, principal }, async (scope) => {
            retained = scope;
            await Promise.resolve();
            return scope.requireTenantId();
          }),
        ),
      ),
    ).toEqual(['a', 'b']);
    expect(() => retained!.requireTenant()).toThrow(TenantError);
    await expect(
      new TenantService({ lookup: new MemoryTenantRegistryStore(), authorize: () => true }).admit({
        tenantId: 'a',
        principal,
      }),
    ).rejects.toThrow();
  });
  it('denies forged selectors, identity conflicts, suspension and unavailable authority', async () => {
    const store = new MemoryTenantRegistryStore([row('a'), row('b')]);
    const service = new TenantService({
      lookup: store,
      authorize: ({ tenant }) => tenant.id === 'a',
    });
    await expect(service.admit({ tenantId: 'b', principal })).rejects.toThrow();
    await service.run({ tenantId: 'a', principal }, (scope) =>
      expect(service.run({ tenantId: 'b', principal, parent: scope }, () => {})).rejects.toThrow(),
    );
    const admin = new TenantRegistry({ store, authorize: () => true });
    await admin.save({ ...row('a'), status: 'suspended' }, 1, principal, 'Suspend access');
    await expect(service.admit({ tenantId: 'a', principal })).rejects.toThrow();
    await expect(
      new TenantService({
        lookup: store,
        authorize: () => {
          throw new Error('store offline');
        },
      }).admit({ tenantId: 'b', principal }),
    ).rejects.toThrow('offline');
    expect(store.audit()).toHaveLength(1);
  });
  it('rejects a revision change during admission and permits already admitted work', async () => {
    const store = new MemoryTenantRegistryStore([row('a')]);
    const admin = new TenantRegistry({ store, authorize: () => true });
    const service = new TenantService({
      lookup: store,
      authorize: async () => {
        await admin.save({ ...row('a'), status: 'suspended' }, 1, principal, 'Suspend');
        return true;
      },
    });
    await expect(service.admit({ tenantId: 'a', principal })).rejects.toThrow();
    await admin.save(row('a'), 2, principal, 'Resume');
    await new TenantService({ lookup: store, authorize: () => true }).run(
      { tenantId: 'a', principal },
      async (scope) => {
        await admin.save({ ...row('a'), status: 'suspended' }, 3, principal, 'Suspend again');
        expect(scope.requireTenantId()).toBe('a');
      },
    );
  });
  it('audits conditional administration and gives targeted scopes no ordinary authority', async () => {
    const store = new MemoryTenantRegistryStore([row('a')]);
    const registry = new TenantRegistry({ store, authorize: () => true });
    const results = await Promise.allSettled([
      registry.save({ ...row('a'), name: 'one' }, 1, principal, 'Edit'),
      registry.save({ ...row('a'), name: 'two' }, 1, principal, 'Edit'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(store.audit()).toHaveLength(1);
    await registry.runForTenant('a', principal, 'Repair configuration', (scope) => {
      expect(scope.requireTenantTarget().id).toBe('a');
      expect(() => scope.requireTenant()).toThrow();
      expect(Object.isFrozen(scope.requireTenantTarget().settings.nested)).toBe(true);
    });
    expect(store.audit()).toHaveLength(2);
  });
});
