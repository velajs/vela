import {
  policyScopeKey,
  parsePolicyBundle,
  parsePolicyDocument,
  validatePolicyWrite,
  type PolicyScope,
  type PolicyStore,
  type PolicyDocument,
  type PolicyBundle,
  type PolicyAudit,
} from '../policy/policy-store';
export interface PolicyPostgresClient {
  query(sql: string, values: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export const policyPostgresSchema = [
  'CREATE TABLE IF NOT EXISTS vela_cedar_policies (scope text PRIMARY KEY, revision integer NOT NULL, bundle jsonb NOT NULL)',
  'CREATE TABLE IF NOT EXISTS vela_cedar_audit (id text PRIMARY KEY, scope text NOT NULL, event jsonb NOT NULL)',
] as const;
/** Supply a primary, cache-disabled Hyperdrive connection for authoritative reads. */
export class PostgresPolicyStore implements PolicyStore {
  constructor(private readonly client: PolicyPostgresClient) {}
  async get(scope: PolicyScope): Promise<PolicyDocument | null> {
    const { rows } = await this.client.query(
      'SELECT revision,bundle FROM vela_cedar_policies WHERE scope=$1',
      [policyScopeKey(scope)],
    );
    return rows[0] ? parsePolicyDocument(rows[0]) : null;
  }
  async put(
    scope: PolicyScope,
    bundle: PolicyBundle,
    expected: number | null,
    audit: PolicyAudit,
  ): Promise<boolean> {
    validatePolicyWrite(expected, audit);
    const values = [
      policyScopeKey(scope),
      (expected ?? 0) + 1,
      JSON.stringify(parsePolicyBundle(bundle)),
      expected,
      audit.id,
      JSON.stringify(audit),
    ];
    const mutation =
      expected === null
        ? 'INSERT INTO vela_cedar_policies(scope,revision,bundle) VALUES($1,$2,$3::jsonb) ON CONFLICT(scope) DO NOTHING RETURNING scope'
        : 'UPDATE vela_cedar_policies SET revision=$2,bundle=$3::jsonb WHERE scope=$1 AND revision=$4 RETURNING scope';
    const { rows } = await this.client.query(
      `WITH input AS (SELECT $4::integer), changed AS (${mutation}), audited AS (INSERT INTO vela_cedar_audit(id,scope,event) SELECT $5,scope,$6::jsonb FROM changed RETURNING id) SELECT id FROM audited`,
      values,
    );
    return rows.length === 1;
  }
}
