import {
  parseTenant,
  tenantId,
  type TenantRecord,
  type TenantAuditEvent,
  type TenantRegistryStore,
} from '../index';
import { directoryOptions } from '../d1/index';

/** Supply a cache-disabled Hyperdrive client. The driver owns its connections. */
export interface TenantPostgresClient {
  query(sql: string, values: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export const tenantPostgresSchema = [
  "CREATE TABLE IF NOT EXISTS vela_tenants (id text PRIMARY KEY, name text NOT NULL, status text NOT NULL CHECK(status IN ('active','suspended')), revision integer NOT NULL, settings jsonb NOT NULL)",
  'CREATE TABLE IF NOT EXISTS vela_tenant_audit (id text PRIMARY KEY, tenant_id text NOT NULL, event jsonb NOT NULL)',
] as const;

export class PostgresTenantRegistryStore implements TenantRegistryStore {
  constructor(private readonly client: TenantPostgresClient) {}
  async get(id: string): Promise<TenantRecord | null> {
    const { rows } = await this.client.query('SELECT * FROM vela_tenants WHERE id = $1', [
      tenantId(id),
    ]);
    return rows[0] ? parseTenant(rows[0]) : null;
  }
  async list(options?: { after?: string; limit?: number }): Promise<readonly TenantRecord[]> {
    const { after, limit } = directoryOptions(options);
    const { rows } = await this.client.query(
      'SELECT * FROM vela_tenants WHERE id > $1 ORDER BY id LIMIT $2',
      [after, limit],
    );
    return rows.map(parseTenant);
  }
  async put(
    input: TenantRecord,
    expected: number | null,
    event: TenantAuditEvent,
  ): Promise<boolean> {
    const row = parseTenant(input);
    if (row.revision !== (expected ?? 0) + 1 || event.tenantId !== row.id)
      throw new TypeError('Invalid tenant transition');
    const values = [
      row.id,
      row.name,
      row.status,
      row.revision,
      JSON.stringify(row.settings),
      expected,
      event.id,
      JSON.stringify(event),
    ];
    const mutation =
      expected === null
        ? 'INSERT INTO vela_tenants(id,name,status,revision,settings) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(id) DO NOTHING RETURNING id'
        : 'UPDATE vela_tenants SET name=$2,status=$3,revision=$4,settings=$5::jsonb WHERE id=$1 AND revision=$6 RETURNING id';
    // $6 must be typed even on the insert branch for PostgreSQL's parameter inference.
    const { rows } = await this.client.query(
      `WITH input AS (SELECT $6::integer), changed AS (${mutation}), audit AS (INSERT INTO vela_tenant_audit(id,tenant_id,event) SELECT $7,id,$8::jsonb FROM changed RETURNING id) SELECT id FROM audit`,
      values,
    );
    return rows.length === 1;
  }
  async appendAudit(event: TenantAuditEvent): Promise<void> {
    await this.client.query(
      'INSERT INTO vela_tenant_audit(id,tenant_id,event) VALUES($1,$2,$3::jsonb)',
      [event.id, tenantId(event.tenantId), JSON.stringify(event)],
    );
  }
}

export interface TenantPostgresTransaction extends TenantPostgresClient {}
export interface TenantPostgresExecutor {
  transaction<T>(work: (transaction: TenantPostgresTransaction) => Promise<T>): Promise<T>;
}
/** Every read/write runs on the same transaction-local tenant connection. */
export function withTenantRls<T>(
  executor: TenantPostgresExecutor,
  tenant: { requireTenantId(): string },
  work: (transaction: TenantPostgresTransaction) => Promise<T>,
): Promise<T> {
  const id = tenantId(tenant.requireTenantId());
  return executor.transaction(async (tx) => {
    await tx.query("SELECT set_config('vela.tenant_id', $1, true)", [id]);
    return work(tx);
  });
}
export function tenantRlsStatements(table: string, column = 'tenant_id'): readonly string[] {
  const quote = (s: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new TypeError('Invalid SQL identifier');
    return `"${s}"`;
  };
  const t = quote(table),
    c = quote(column);
  const condition = `${c}::text = nullif(current_setting('vela.tenant_id', true), '')`;
  return [
    `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY vela_tenant_permit ON ${t} AS PERMISSIVE FOR ALL USING (${condition}) WITH CHECK (${condition})`,
    `CREATE POLICY vela_tenant_restrict ON ${t} AS RESTRICTIVE FOR ALL USING (${condition}) WITH CHECK (${condition})`,
  ];
}
