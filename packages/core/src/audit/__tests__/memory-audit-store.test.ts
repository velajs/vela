import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryAuditStore, calculateChanges, type AuditEntry } from '../index';

/**
 * MemoryAuditStore — the plain-array reference implementation of the
 * `AuditStore` seam, plus `calculateChanges`. Parity with hono-crud 0.13
 * `MemoryAuditLogStorage` + `calculateChanges` (the engine builds entries; the
 * store persists via `log`/`logBatch` and reads back via `query`).
 */

function entry(
  partial: Partial<AuditEntry> & Pick<AuditEntry, 'action' | 'tableName' | 'recordId'>,
): AuditEntry {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    ...partial,
  } as AuditEntry;
}

describe('MemoryAuditStore', () => {
  let store: MemoryAuditStore;

  beforeEach(() => {
    store = new MemoryAuditStore();
  });

  it('logs and retrieves a single entry', async () => {
    await store.log(
      entry({
        action: 'create',
        tableName: 'users',
        recordId: '123',
        userId: 'user-456',
        record: { name: 'John' },
      }),
    );

    const all = store.all();
    expect(all).toHaveLength(1);
    expect(all[0].action).toBe('create');
    expect(all[0].recordId).toBe('123');
    expect(all[0].userId).toBe('user-456');
  });

  it('logBatch persists every entry', async () => {
    await store.logBatch([
      entry({ action: 'batch_create', tableName: 'users', recordId: 'a' }),
      entry({ action: 'batch_create', tableName: 'users', recordId: 'b' }),
      entry({ action: 'batch_create', tableName: 'users', recordId: 'c' }),
    ]);
    expect(store.all()).toHaveLength(3);
  });

  it('queries by recordId', async () => {
    await store.log(entry({ action: 'create', tableName: 'users', recordId: '123' }));
    await store.log(entry({ action: 'create', tableName: 'users', recordId: '456' }));
    await store.log(entry({ action: 'update', tableName: 'users', recordId: '123' }));

    const logsFor123 = await store.query({ tableName: 'users', recordId: '123' });
    expect(logsFor123).toHaveLength(2);
    expect(logsFor123.every((log) => log.recordId === '123')).toBe(true);
  });

  it('queries by action and userId', async () => {
    await store.log(
      entry({ action: 'create', tableName: 'users', recordId: '123', userId: 'user-1' }),
    );
    await store.log(
      entry({ action: 'update', tableName: 'users', recordId: '123', userId: 'user-2' }),
    );

    expect(await store.query({ action: 'create' })).toHaveLength(1);
    expect(await store.query({ userId: 'user-1' })).toHaveLength(1);
  });

  it('paginates query results', async () => {
    for (let i = 0; i < 10; i++) {
      await store.log(entry({ action: 'create', tableName: 'users', recordId: `${i}` }));
    }
    expect(await store.query({ limit: 3, offset: 0 })).toHaveLength(3);
    expect(await store.query({ limit: 3, offset: 3 })).toHaveLength(3);
  });

  it('filters by date range', async () => {
    const early = entry({ action: 'create', tableName: 'users', recordId: 'a' });
    early.timestamp = new Date('2024-01-01T00:00:00Z');
    const late = entry({ action: 'create', tableName: 'users', recordId: 'b' });
    late.timestamp = new Date('2024-06-01T00:00:00Z');
    await store.logBatch([early, late]);

    const afterMarch = await store.query({ startDate: new Date('2024-03-01T00:00:00Z') });
    expect(afterMarch).toHaveLength(1);
    expect(afterMarch[0].recordId).toBe('b');
  });
});

describe('calculateChanges', () => {
  it('computes field changes correctly', () => {
    const changes = calculateChanges(
      { name: 'John', email: 'john@test.com', role: 'user' },
      { name: 'John Doe', email: 'john@test.com', role: 'admin' },
    );
    expect(changes).toHaveLength(2);
    expect(changes).toContainEqual({ field: 'name', oldValue: 'John', newValue: 'John Doe' });
    expect(changes).toContainEqual({ field: 'role', oldValue: 'user', newValue: 'admin' });
  });

  it('respects exclude fields', () => {
    const changes = calculateChanges(
      { name: 'John', updatedAt: new Date('2024-01-01') },
      { name: 'John Doe', updatedAt: new Date('2024-01-02') },
      ['updatedAt'],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe('name');
  });

  it('detects added and removed fields', () => {
    const changes = calculateChanges(
      { name: 'John', oldField: 'value' },
      { name: 'John', newField: 'value' },
    );
    expect(changes).toHaveLength(2);
    expect(changes).toContainEqual({ field: 'oldField', oldValue: 'value', newValue: undefined });
    expect(changes).toContainEqual({ field: 'newField', oldValue: undefined, newValue: 'value' });
  });

  it('compares nested values structurally', () => {
    expect(calculateChanges({ tags: ['a', 'b'] }, { tags: ['a', 'b'] })).toHaveLength(0);
    expect(calculateChanges({ tags: ['a'] }, { tags: ['a', 'b'] })).toHaveLength(1);
  });
});
