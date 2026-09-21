import type { SqliteStorage } from '../storage-types';
import {
  policyScopeKey,
  parsePolicyBundle,
  validatePolicyWrite,
  type PolicyScope,
  type PolicyStore,
  type PolicyDocument,
  type PolicyBundle,
  type PolicyAudit,
} from '../policy/policy-store';
import { decodePolicyRow, policySqliteSchema } from '../d1/index';
export class DurableObjectPolicyStore implements PolicyStore {
  constructor(private readonly storage: SqliteStorage) {}
  migrate(): void {
    for (const sql of policySqliteSchema) this.storage.sql.exec(sql);
  }
  async get(scope: PolicyScope): Promise<PolicyDocument | null> {
    const row = this.storage.sql
      .exec('SELECT revision,bundle FROM vela_cedar_policies WHERE scope=?', policyScopeKey(scope))
      .toArray()[0];
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
      json = JSON.stringify(parsePolicyBundle(bundle));
    return this.storage.transactionSync(() => {
      const current = this.storage.sql
        .exec('SELECT revision FROM vela_cedar_policies WHERE scope=?', key)
        .toArray()[0];
      if ((current?.revision ?? null) !== expected) return false;
      this.storage.sql.exec(
        'INSERT INTO vela_cedar_policies(scope,revision,bundle) VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,bundle=excluded.bundle',
        key,
        (expected ?? 0) + 1,
        json,
      );
      this.storage.sql.exec(
        'INSERT INTO vela_cedar_audit(id,scope,event) VALUES(?,?,?)',
        audit.id,
        key,
        JSON.stringify(audit),
      );
      return true;
    });
  }
}
