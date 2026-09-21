import type { D1Binding } from '../storage-types';
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
export const policySqliteSchema = [
  'CREATE TABLE IF NOT EXISTS vela_cedar_policies (scope TEXT PRIMARY KEY, revision INTEGER NOT NULL, bundle TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS vela_cedar_audit (id TEXT PRIMARY KEY, scope TEXT NOT NULL, event TEXT NOT NULL)',
] as const;
export function decodePolicyRow(row: Record<string, unknown>): PolicyDocument {
  if (typeof row.bundle !== 'string') throw new TypeError('Invalid policy bundle column');
  return parsePolicyDocument({ ...row, bundle: JSON.parse(row.bundle) });
}
export class D1PolicyStore implements PolicyStore {
  constructor(private readonly database: D1Binding) {}
  async get(scope: PolicyScope): Promise<PolicyDocument | null> {
    const row = await this.database
      .prepare('SELECT revision,bundle FROM vela_cedar_policies WHERE scope=?')
      .bind(policyScopeKey(scope))
      .first<Record<string, unknown>>();
    return row ? decodePolicyRow(row) : null;
  }
  async put(
    scope: PolicyScope,
    bundle: PolicyBundle,
    expected: number | null,
    audit: PolicyAudit,
  ): Promise<boolean> {
    validatePolicyWrite(expected, audit);
    const key = policyScopeKey(scope),
      json = JSON.stringify(parsePolicyBundle(bundle)),
      revision = (expected ?? 0) + 1;
    const mutation =
      expected === null
        ? this.database
            .prepare(
              'INSERT INTO vela_cedar_policies(scope,revision,bundle) VALUES(?,?,?) ON CONFLICT(scope) DO NOTHING',
            )
            .bind(key, revision, json)
        : this.database
            .prepare(
              'UPDATE vela_cedar_policies SET revision=?,bundle=? WHERE scope=? AND revision=?',
            )
            .bind(revision, json, key, expected);
    const [result] = await this.database.batch([
      mutation,
      this.database
        .prepare('INSERT INTO vela_cedar_audit(id,scope,event) SELECT ?,?,? WHERE changes()=1')
        .bind(audit.id, key, JSON.stringify(audit)),
    ]);
    return result?.meta.changes === 1;
  }
}
