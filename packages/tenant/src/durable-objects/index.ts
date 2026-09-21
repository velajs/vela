import type { SqliteStorage } from '../storage-types';
import {
  parseTenant,
  tenantId,
  type TenantRecord,
  type TenantAuditEvent,
  type TenantRegistryStore,
} from '../index';
import { tenantSqliteSchema, decodeTenantRow, directoryOptions } from '../d1/index';

/** Construct inside a SQLite Durable Object; expose only authenticated application RPC. */
export class DurableObjectTenantRegistryStore implements TenantRegistryStore {
  constructor(private readonly storage: SqliteStorage) {}
  migrate(): void {
    for (const statement of tenantSqliteSchema) this.storage.sql.exec(statement);
  }
  async get(id: string): Promise<TenantRecord | null> {
    const row = this.storage.sql
      .exec('SELECT * FROM vela_tenants WHERE id = ?', tenantId(id))
      .toArray()[0];
    return row ? decodeTenantRow(row) : null;
  }
  async list(options?: { after?: string; limit?: number }): Promise<readonly TenantRecord[]> {
    const { after, limit } = directoryOptions(options);
    return this.storage.sql
      .exec('SELECT * FROM vela_tenants WHERE id > ? ORDER BY id LIMIT ?', after, limit)
      .toArray()
      .map(decodeTenantRow);
  }
  async put(
    input: TenantRecord,
    expected: number | null,
    event: TenantAuditEvent,
  ): Promise<boolean> {
    const row = parseTenant(input);
    if (row.revision !== (expected ?? 0) + 1 || event.tenantId !== row.id)
      throw new TypeError('Invalid tenant transition');
    return this.storage.transactionSync(() => {
      const current = this.storage.sql
        .exec('SELECT revision FROM vela_tenants WHERE id=?', row.id)
        .toArray()[0];
      if ((current?.revision ?? null) !== expected) return false;
      this.storage.sql.exec(
        'INSERT INTO vela_tenants(id,name,status,revision,settings) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,revision=excluded.revision,settings=excluded.settings',
        row.id,
        row.name,
        row.status,
        row.revision,
        JSON.stringify(row.settings),
      );
      this.storage.sql.exec(
        'INSERT INTO vela_tenant_audit(id,tenant_id,event) VALUES(?,?,?)',
        event.id,
        row.id,
        JSON.stringify(event),
      );
      return true;
    });
  }
  async appendAudit(event: TenantAuditEvent): Promise<void> {
    this.storage.sql.exec(
      'INSERT INTO vela_tenant_audit(id,tenant_id,event) VALUES(?,?,?)',
      event.id,
      tenantId(event.tenantId),
      JSON.stringify(event),
    );
  }
}
