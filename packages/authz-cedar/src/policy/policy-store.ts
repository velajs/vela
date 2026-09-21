import type { PolicySet } from '../cedar/binding';
import { entityRefToUid, type EntityRef } from '../cedar/uid';
export type PolicyScopeId = string;
export interface PolicyScope {
  readonly application: string;
  readonly environment: string;
  readonly tenantId: string;
}
export interface PolicyBundle {
  readonly policies: Readonly<Record<string, string>>;
  readonly templates?: Readonly<Record<string, string>>;
  readonly links?: readonly {
    readonly id: string;
    readonly templateId: string;
    readonly principal?: EntityRef;
    readonly resource?: EntityRef;
  }[];
}
export interface PolicyDocument {
  readonly revision: number;
  readonly bundle: PolicyBundle;
}
export interface PolicyAudit {
  readonly id: string;
  readonly actor: string;
  readonly reason: string;
  readonly at: number;
}
export interface PolicyStore {
  /** Authoritative, cache-disabled read on every admission. Missing means deny. */
  get(scope: PolicyScope): Promise<PolicyDocument | null>;
  /** Revision compare-and-set and durable audit must commit together. */
  put(
    scope: PolicyScope,
    bundle: PolicyBundle,
    expectedRevision: number | null,
    audit: PolicyAudit,
  ): Promise<boolean>;
}
export function policyScopeKey(scope: PolicyScope): string {
  return JSON.stringify(
    [scope.application, scope.environment, scope.tenantId].map((value) => {
      if (
        typeof value !== 'string' ||
        !value ||
        value.trim() !== value ||
        value.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(value)
      )
        throw new TypeError('Invalid policy scope');
      return value.normalize('NFC');
    }),
  );
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1_000_000)
    throw new TypeError('Invalid policy value');
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid policy object');
  return Object.fromEntries(Object.entries(value));
}
function texts(value: unknown): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(Object.entries(object(value)).map(([k, v]) => [string(k), string(v)])),
  );
}
function ref(value: unknown): EntityRef {
  const r = object(value);
  return Object.freeze({ type: string(r.type), id: string(r.id) });
}
export function parsePolicyBundle(value: unknown): PolicyBundle {
  const v = object(value);
  const policies = texts(v.policies);
  const templates = v.templates === undefined ? undefined : texts(v.templates);
  if (v.links !== undefined && !Array.isArray(v.links))
    throw new TypeError('Invalid template links');
  const links = v.links?.map((item: unknown) => {
    const link = object(item);
    return Object.freeze({
      id: string(link.id),
      templateId: string(link.templateId),
      ...(link.principal === undefined ? {} : { principal: ref(link.principal) }),
      ...(link.resource === undefined ? {} : { resource: ref(link.resource) }),
    });
  });
  if (
    Object.keys(policies).length + Object.keys(templates ?? {}).length + (links?.length ?? 0) >
    10_000
  )
    throw new TypeError('Policy bundle too large');
  return Object.freeze({
    policies,
    ...(templates ? { templates } : {}),
    ...(links ? { links: Object.freeze(links) } : {}),
  });
}
export function parsePolicyDocument(value: unknown): PolicyDocument {
  const v = object(value);
  if (typeof v.revision !== 'number' || !Number.isSafeInteger(v.revision) || v.revision < 1)
    throw new TypeError('Invalid policy revision');
  return Object.freeze({ revision: v.revision, bundle: parsePolicyBundle(v.bundle) });
}
export function policySet(bundle: PolicyBundle, namespace: string): PolicySet {
  const parsed = parsePolicyBundle(bundle);
  return {
    staticPolicies: { ...parsed.policies },
    templates: { ...parsed.templates },
    templateLinks: (parsed.links ?? []).map((link) => ({
      newId: link.id,
      templateId: link.templateId,
      values: {
        ...(link.principal ? { '?principal': entityRefToUid(link.principal, namespace) } : {}),
        ...(link.resource ? { '?resource': entityRefToUid(link.resource, namespace) } : {}),
      },
    })),
  };
}
export function validatePolicyWrite(expected: number | null, audit: PolicyAudit): void {
  if (expected !== null && (!Number.isSafeInteger(expected) || expected < 1))
    throw new TypeError('Invalid expected revision');
  string(audit.id);
  string(audit.actor);
  string(audit.reason);
  if (!Number.isSafeInteger(audit.at) || audit.at < 0) throw new TypeError('Invalid audit time');
}
export class MemoryPolicyStore implements PolicyStore {
  readonly #documents = new Map<string, PolicyDocument>();
  readonly #audit: unknown[] = [];
  async get(scope: PolicyScope): Promise<PolicyDocument | null> {
    return this.#documents.get(policyScopeKey(scope)) ?? null;
  }
  async put(
    scope: PolicyScope,
    bundle: PolicyBundle,
    expected: number | null,
    audit: PolicyAudit,
  ): Promise<boolean> {
    validatePolicyWrite(expected, audit);
    const key = policyScopeKey(scope),
      parsed = parsePolicyBundle(bundle);
    if ((this.#documents.get(key)?.revision ?? null) !== expected) return false;
    this.#documents.set(key, Object.freeze({ revision: (expected ?? 0) + 1, bundle: parsed }));
    this.#audit.push(structuredClone({ scope, audit }));
    return true;
  }
  audit(): readonly unknown[] {
    return structuredClone(this.#audit);
  }
}
