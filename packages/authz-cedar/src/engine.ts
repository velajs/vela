import type { CedarBinding, EntityJson, PolicySet } from './cedar/binding';
import { actionUid, entityRefToUid, type EntityRef } from './cedar/uid';
import {
  unwrapAuthorization,
  unwrapCheckParse,
  unwrapPartialAuthorization,
  unwrapValidation,
} from './cedar/answers';
import { entityGraph, toCedarValue } from './entities/entity-builder';
import type { EntityProvider, EntityResolutionRequest } from './entities/entity-provider';
import type {
  ActionOf,
  AnyVocabulary,
  ContextFor,
  PrincipalTypeFor,
  EntityNameOf,
  ResourceTypeFor,
} from './vocabulary/types';
import { compileResiduals, type CompiledPlan } from './plan/compile-residuals';
import {
  parsePolicyDocument,
  policyScopeKey,
  policySet,
  type PolicyScope,
  type PolicyStore,
  type PolicyBundle,
  type PolicyAudit,
} from './policy/policy-store';
export interface DecisionDiagnostics {
  readonly revision: number;
  readonly scope: PolicyScope;
  readonly elapsedMs: number;
  readonly policyIds: readonly string[];
}
export interface CedarDecision {
  readonly allowed: boolean;
  readonly diagnostics: DecisionDiagnostics;
}
export interface CedarQueryPlan extends CompiledPlan {
  readonly diagnostics: DecisionDiagnostics;
  readonly resourceType: string;
}
export interface CedarEngineOptions<V extends AnyVocabulary> {
  vocabulary: V;
  binding: CedarBinding;
  store: PolicyStore;
  entityProvider?: EntityProvider<V>;
  maxCompiledScopes?: number;
  onDecision?: (event: CedarDecision | CedarQueryPlan) => void;
}
export interface CheckRequest<V extends AnyVocabulary, A extends ActionOf<V>> {
  scope: PolicyScope;
  principal: EntityRef<PrincipalTypeFor<V, A>>;
  action: A;
  resource: EntityRef<ResourceTypeFor<V, A>>;
  context: ContextFor<V, A>;
  entities?: readonly EntityJson[];
}
export interface PlanRequest<V extends AnyVocabulary, A extends ActionOf<V>> {
  scope: PolicyScope;
  principal: EntityRef<PrincipalTypeFor<V, A>>;
  action: A;
  resourceType: ResourceTypeFor<V, A> & EntityNameOf<V>;
  context: ContextFor<V, A>;
  entities?: readonly EntityJson[];
}
interface Prepared {
  id: string;
  policies: PolicySet;
  revision: number;
  fingerprint: string;
}
/** Engine state belongs to one application/environment instance. Only compiled code is cached. */
export class CedarEngine<V extends AnyVocabulary> {
  readonly #cache = new Map<string, Prepared>();
  readonly #instance = crypto.randomUUID();
  #sequence = 0;
  #disposed = false;
  constructor(private readonly options: CedarEngineOptions<V>) {
    if (
      !Number.isSafeInteger(options.maxCompiledScopes ?? 32) ||
      (options.maxCompiledScopes ?? 32) < 1
    )
      throw new TypeError('Invalid compiled-policy cache size');
    unwrapCheckParse(
      options.binding.preparseSchema(this.#instance, options.vocabulary.cedarSchemaJson),
      { code: 'SCHEMA_INVALID', message: 'Invalid Cedar vocabulary' },
    );
  }
  #active(): void {
    if (this.#disposed) throw new Error('Cedar engine disposed');
  }
  validate(bundle: PolicyBundle): void {
    this.#active();
    const report = unwrapValidation(
      this.options.binding.validate({
        schema: this.options.vocabulary.cedarSchemaJson,
        policies: policySet(bundle, this.options.vocabulary.namespace),
      }),
      { code: 'POLICY_INVALID', message: 'Invalid Cedar policies' },
    );
    if (report.validationErrors.length)
      throw new Error(`Cedar policy validation failed: ${JSON.stringify(report.validationErrors)}`);
  }
  async save(
    scope: PolicyScope,
    bundle: PolicyBundle,
    expected: number | null,
    audit: PolicyAudit,
  ): Promise<void> {
    this.validate(bundle);
    if (!(await this.options.store.put(scope, bundle, expected, audit)))
      throw new Error('Policy revision conflict');
  }
  #prepare(scope: PolicyScope, document: ReturnType<typeof parsePolicyDocument>): Prepared {
    this.#active();
    const scopeKey = policyScopeKey(scope),
      key = JSON.stringify([scopeKey, document.revision]);
    const fingerprint = JSON.stringify(document.bundle),
      cached = this.#cache.get(key);
    if (cached) {
      if (cached.fingerprint !== fingerprint)
        throw new Error('Policy store changed content without a revision');
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return cached;
    }
    this.validate(document.bundle);
    const policies = policySet(document.bundle, this.options.vocabulary.namespace);
    let id = `${this.#instance}:${++this.#sequence}`;
    if (this.#cache.size >= (this.options.maxCompiledScopes ?? 32)) {
      const oldest = this.#cache.entries().next().value;
      if (oldest) {
        this.#cache.delete(oldest[0]);
        id = oldest[1].id;
      }
    }
    unwrapCheckParse(this.options.binding.preparsePolicySet(id, policies), {
      code: 'POLICY_INVALID',
      message: 'Cannot prepare Cedar policies',
    });
    const entry = { id, policies, revision: document.revision, fingerprint };
    this.#cache.set(key, entry);
    return entry;
  }
  async #entities<A extends ActionOf<V>>(
    request: CheckRequest<V, A> | PlanRequest<V, A>,
  ): Promise<EntityJson[]> {
    if (request.entities) return [...entityGraph(...request.entities)];
    const provider = this.options.entityProvider;
    if (!provider)
      throw new Error('Supply operation-local entities or an authoritative entity provider');
    const resolution: EntityResolutionRequest<V> = {
      scope: policyScopeKey(request.scope),
      principal: request.principal,
      action: request.action,
      ...('resource' in request
        ? { resource: request.resource }
        : { resourceType: request.resourceType }),
    };
    const principal = await provider.resolvePrincipal(resolution);
    const resource =
      'resource' in request ? ((await provider.resolveResource?.(resolution)) ?? []) : [];
    const additional = (await provider.resolveAdditional?.(resolution)) ?? [];
    return [...entityGraph(...principal, ...resource, ...additional)];
  }
  async check<A extends ActionOf<V>>(request: CheckRequest<V, A>): Promise<CedarDecision> {
    this.#active();
    const start = performance.now();
    policyScopeKey(request.scope);
    // Resolve grants per operation, then read the authoritative policy revision.
    const entities = await this.#entities(request),
      document = await this.options.store.get(request.scope);
    if (!document)
      return {
        allowed: false,
        diagnostics: {
          revision: 0,
          scope: request.scope,
          elapsedMs: performance.now() - start,
          policyIds: [],
        },
      };
    const prepared = this.#prepare(request.scope, parsePolicyDocument(document));
    const response = unwrapAuthorization(
      this.options.binding.statefulIsAuthorized({
        principal: entityRefToUid(request.principal, this.options.vocabulary.namespace),
        action: actionUid(this.options.vocabulary.namespace, request.action),
        resource: entityRefToUid(request.resource, this.options.vocabulary.namespace),
        context: Object.fromEntries(
          Object.entries(request.context)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [
              key,
              toCedarValue(value, { namespace: this.options.vocabulary.namespace }),
            ]),
        ),
        entities,
        preparsedSchemaName: this.#instance,
        validateRequest: true,
        preparsedPolicySetId: prepared.id,
      }),
      { code: 'EVALUATION_FAILED', message: 'Cedar evaluation failed' },
    );
    // Errored forbids must never disappear into Cedar's skip-on-error semantics.
    if (response.diagnostics.errors.length)
      throw new Error(
        `Cedar policy evaluation failed: ${JSON.stringify(response.diagnostics.errors)}`,
      );
    const decision: CedarDecision = Object.freeze({
      allowed: response.decision === 'allow',
      diagnostics: {
        revision: prepared.revision,
        scope: request.scope,
        elapsedMs: performance.now() - start,
        policyIds: response.diagnostics.reason,
      },
    });
    this.options.onDecision?.(decision);
    return decision;
  }
  async plan<A extends ActionOf<V>>(request: PlanRequest<V, A>): Promise<CedarQueryPlan> {
    this.#active();
    const start = performance.now();
    policyScopeKey(request.scope);
    const entities = await this.#entities(request),
      document = await this.options.store.get(request.scope);
    if (!document)
      return {
        kind: 'ALWAYS_DENY',
        condition: { op: 'false' },
        approximations: [],
        postFilter: false,
        residualPolicyIds: [],
        erroredPolicyIds: [],
        resourceType: request.resourceType,
        diagnostics: {
          revision: 0,
          scope: request.scope,
          elapsedMs: performance.now() - start,
          policyIds: [],
        },
      };
    const prepared = this.#prepare(request.scope, parsePolicyDocument(document));
    const response = unwrapPartialAuthorization(
      this.options.binding.isAuthorizedPartial({
        principal: entityRefToUid(request.principal, this.options.vocabulary.namespace),
        action: actionUid(this.options.vocabulary.namespace, request.action),
        resource: null,
        context: Object.fromEntries(
          Object.entries(request.context)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [
              key,
              toCedarValue(value, { namespace: this.options.vocabulary.namespace }),
            ]),
        ),
        entities,
        policies: prepared.policies,
        schema: this.options.vocabulary.cedarSchemaJson,
        validateRequest: true,
      }),
      { code: 'EVALUATION_FAILED', message: 'Cedar planning failed' },
    );
    const compiled = compileResiduals(response, {
      resourceType: request.resourceType,
      namespace: this.options.vocabulary.namespace,
      scope: policyScopeKey(request.scope),
      action: request.action,
      unsupportedResidual: 'error',
      onErroredPolicy: 'error',
    });
    // Even restrictive approximations are rejected: query plans must be exact.
    if (compiled.approximations.length || compiled.postFilter)
      throw new Error('Unsupported Cedar query expression');
    const plan: CedarQueryPlan = {
      ...compiled,
      resourceType: request.resourceType,
      diagnostics: {
        revision: prepared.revision,
        scope: request.scope,
        elapsedMs: performance.now() - start,
        policyIds: compiled.residualPolicyIds,
      },
    };
    this.options.onDecision?.(plan);
    return plan;
  }
  dispose(): void {
    for (const entry of this.#cache.values()) this.options.binding.preparsePolicySet(entry.id, {});
    this.#cache.clear();
    this.#disposed = true;
  }
}
export function createCedarEngine<V extends AnyVocabulary>(
  options: CedarEngineOptions<V>,
): CedarEngine<V> {
  return new CedarEngine(options);
}
