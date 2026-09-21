import type { D1Binding } from '../storage-types';
import {
  parseTenant,
  tenantId,
  type TenantRecord,
  type TenantAuditEvent,
  type TenantRegistryStore,
} from '../index';

export const tenantSqliteSchema = [
  "CREATE TABLE IF NOT EXISTS vela_tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','suspended')), revision INTEGER NOT NULL, settings TEXT NOT NULL)",
  'CREATE TABLE IF NOT EXISTS vela_tenant_audit (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, event TEXT NOT NULL)',
] as const;

export function decodeTenantRow(row: Record<string, unknown>): TenantRecord {
  if (typeof row.settings !== 'string') throw new TypeError('Invalid tenant settings column');
  return parseTenant({ ...row, settings: JSON.parse(row.settings) });
}
export function directoryOptions(options: { after?: string; limit?: number } = {}): {
  after: string;
  limit: number;
} {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new TypeError('Invalid directory limit');
  return { after: options.after ?? '', limit };
}
/** Admission uses the primary binding, never a replica session or KV snapshot. */
export class D1TenantRegistryStore implements TenantRegistryStore {
  constructor(private readonly database: D1Binding) {}
  async get(id: string): Promise<TenantRecord | null> {
    const row = await this.database
      .prepare('SELECT * FROM vela_tenants WHERE id = ?')
      .bind(tenantId(id))
      .first<Record<string, unknown>>();
    return row ? decodeTenantRow(row) : null;
  }
  async list(options?: { after?: string; limit?: number }): Promise<readonly TenantRecord[]> {
    const { after, limit } = directoryOptions(options);
    const result = await this.database
      .prepare('SELECT * FROM vela_tenants WHERE id > ? ORDER BY id LIMIT ?')
      .bind(after, limit)
      .all<Record<string, unknown>>();
    return result.results.map(decodeTenantRow);
  }
  async put(
    input: TenantRecord,
    expected: number | null,
    event: TenantAuditEvent,
  ): Promise<boolean> {
    const record = parseTenant(input);
    if (record.revision !== (expected ?? 0) + 1 || event.tenantId !== record.id)
      throw new TypeError('Invalid tenant transition');
    const mutation =
      expected === null
        ? this.database
            .prepare(
              'INSERT INTO vela_tenants(id,name,status,revision,settings) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
            )
            .bind(
              record.id,
              record.name,
              record.status,
              record.revision,
              JSON.stringify(record.settings),
            )
        : this.database
            .prepare(
              'UPDATE vela_tenants SET name=?,status=?,revision=?,settings=? WHERE id=? AND revision=?',
            )
            .bind(
              record.name,
              record.status,
              record.revision,
              JSON.stringify(record.settings),
              record.id,
              expected,
            );
    const [result] = await this.database.batch([
      mutation,
      this.database
        .prepare(
          'INSERT INTO vela_tenant_audit(id,tenant_id,event) SELECT ?,?,? WHERE changes() = 1',
        )
        .bind(event.id, record.id, JSON.stringify(event)),
    ]);
    return result?.meta.changes === 1;
  }
  async appendAudit(event: TenantAuditEvent): Promise<void> {
    await this.database
      .prepare('INSERT INTO vela_tenant_audit(id,tenant_id,event) VALUES(?,?,?)')
      .bind(event.id, tenantId(event.tenantId), JSON.stringify(event))
      .run();
  }
}
