import { validateSchema, getTrustedRequestIdentity } from '@velajs/vela';
import type { AdapterScope, RuntimeAdapter } from '../adapter/contract';
import type { FilterCondition, Lookup } from '../adapter/query-types';
import { CrudException, ForbiddenException, InputValidationException } from '../envelope/errors';
import {
  matchesPredicate,
  predicateFilter,
  validatePredicate,
  type QueryPredicate,
} from '../query/predicate';
import type { CrudEndpointName } from '../verb-table';
import type { EngineRequest } from './engine-request';
import type { CrudResource } from './resource';
import { buildHookContext, buildPolicyContext } from './verb-helpers';
import { parseIdentifier } from './identifier';

type Row = Record<string, unknown>;
export type AuthorizationPlan =
  | { kind: 'allow' }
  | { kind: 'deny' }
  | { kind: 'conditional'; predicate: QueryPredicate };
export type CommitMutation =
  | {
      readonly operation: 'create' | 'update' | 'delete' | 'restore' | 'upsert';
      readonly row: Readonly<Row>;
    }
  | { readonly operation: 'updateMany'; readonly count: number };
export interface CommitEvent {
  readonly resource: string;
  readonly verb: CrudEndpointName;
  readonly tenantId?: string;
  readonly mutations: readonly CommitMutation[];
}

/** Operation-local wrapper: no request authority is cached on a compiled resource. */
export async function prepareOperation(
  base: CrudResource,
  request: EngineRequest,
  verb: CrudEndpointName,
): Promise<{ resource: CrudResource; request: EngineRequest }> {
  let req = { ...request, vars: { ...request.vars } };
  if (request.tenant) {
    const id = request.tenant.requireTenantId();
    if (req.vars.tenantId !== undefined && req.vars.tenantId !== id)
      throw new ForbiddenException('Conflicting tenant context');
    req.vars.tenantId = id;
  }
  const identity = req.request ? getTrustedRequestIdentity(req.request) : undefined;
  if (identity?.tenantId !== undefined) {
    if (req.vars.tenantId !== undefined && req.vars.tenantId !== identity.tenantId)
      throw new ForbiddenException('Conflicting authenticated tenant');
    req.vars.tenantId = identity.tenantId;
  }
  const contracts = { ...base.model.contracts, ...base.config.contracts };
  if (
    contracts.id &&
    (req.id !== undefined || base.model.primaryKeys.every((k) => req.params?.[k] !== undefined))
  ) {
    const input =
      base.model.primaryKeys.length > 1
        ? (req.id ?? req.params)
        : (req.id ?? req.params?.[base.model.primaryKeys[0]!]);
    req = { ...req, id: await parseIdentifier(base, input) };
  }
  const cfg = base.config;
  const fixed: Row = {};
  if (base.model.tenantField && req.vars.tenantId !== undefined)
    fixed[base.model.tenantField] = req.vars.tenantId;
  for (const [field, param] of Object.entries(cfg.collection?.parents ?? {})) {
    if (!Object.hasOwn(base.model.schema.shape, field))
      throw new TypeError(`Unknown collection field '${field}'`);
    const selector = req.params?.[param];
    if (!selector) throw new InputValidationException(`Missing parent collection '${param}'`);
    const value = base.model.fields?.[field]?.type === 'number' ? Number(selector) : selector;
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new InputValidationException(`Invalid parent collection '${param}'`);

    if (Object.hasOwn(fixed, field) && fixed[field] !== value)
      throw new ForbiddenException('Conflicting collection scope');
    fixed[field] = value;
  }
  const plan =
    cfg.authorization === undefined
      ? { kind: 'allow' as const }
      : await cfg.authorization(buildPolicyContext(req), verb);
  if (!plan || typeof plan !== 'object') throw new TypeError('Invalid authorization plan');
  if (plan.kind === 'deny') throw new ForbiddenException();
  if (plan.kind !== 'allow' && plan.kind !== 'conditional')
    throw new TypeError('Invalid authorization plan');
  const condition =
    plan.kind === 'conditional'
      ? validatePredicate(plan.predicate, new Set(Object.keys(base.model.schema.shape)))
      : undefined;
  const adapter = cfg.adapter;
  if (condition && !adapter.capabilities.has('structuredPredicates'))
    throw new CrudException(
      'Adapter does not support structured authorization predicates',
      500,
      'PREDICATE_UNSUPPORTED',
    );
  const filters = (input: FilterCondition[]): FilterCondition[] => [
    ...input,
    ...Object.entries(fixed).map(
      ([field, value]): FilterCondition => ({ field, operator: 'eq', value }),
    ),
    ...(condition ? [predicateFilter(condition)] : []),
  ];
  const lookup = (input: Lookup): Lookup => ({
    ...input,
    filters: {
      ...input.filters,
      ...Object.fromEntries(Object.entries(fixed).map(([k, v]) => [k, String(v)])),
    },
    ...(condition
      ? {
          predicate: input.predicate
            ? { op: 'and', args: [input.predicate, condition] }
            : condition,
        }
      : {}),
  });
  const input = (row: Row, create = false): Row => {
    const result = { ...row };
    for (const [key, value] of Object.entries(fixed)) {
      if (Object.hasOwn(row, key) && String(row[key]) !== String(value))
        throw new ForbiddenException('Cannot override collection scope');
      if (create) result[key] = value;
    }
    if (create && condition && !matchesPredicate(result, condition)) throw new ForbiddenException();
    return result;
  };
  const events = new WeakMap<AdapterScope, CommitMutation[]>();
  const record = (
    scope: AdapterScope,
    operation: Exclude<CommitMutation['operation'], 'updateMany'>,
    row: Row | null,
  ): void => {
    if (row && cfg.afterCommit)
      events
        .get(scope)
        ?.push(Object.freeze({ operation, row: Object.freeze(structuredClone(row)) }));
  };
  const run = async <T>(
    method: RuntimeAdapter['requestScope'],
    work: (scope: AdapterScope) => Promise<T>,
    context?: Parameters<RuntimeAdapter['requestScope']>[1],
  ): Promise<T> => {
    let mutations: CommitMutation[] = [];
    const result = await method(async (scope) => {
      events.set(scope, mutations);
      try {
        return await work(scope);
      } finally {
        events.delete(scope);
      }
    }, context);
    if (cfg.afterCommit && mutations.length) {
      const event: CommitEvent = Object.freeze({
        resource: base.name,
        verb,
        ...(req.vars.tenantId === undefined ? {} : { tenantId: req.vars.tenantId }),
        mutations: Object.freeze(mutations),
      });
      try {
        await cfg.afterCommit(event);
      } catch (error) {
        try {
          if (cfg.onAfterCommitError) await cfg.onAfterCommitError(error, event);
          else console.error('[crud] committed write delivery failed', error);
        } catch (reportError) {
          console.error('[crud] post-commit error reporter failed', reportError);
        }
      }
    }
    return result;
  };
  const wrapped: RuntimeAdapter = {
    ...adapter,
    requestScope: (fn, ctx) => run(adapter.requestScope.bind(adapter), fn, ctx),
    transaction: (fn, ctx) => run(adapter.transaction.bind(adapter), fn, ctx),
    create: async (row, scope) => {
      const result = await adapter.create(input(row, true), scope);
      record(scope, 'create', result);
      return result;
    },
    readOne: (key, opts, scope) => adapter.readOne(lookup(key), opts, scope),
    update: async (key, row, scope) => {
      const result = await adapter.update(lookup(key), input(row), scope);
      record(scope, 'update', result);
      return result;
    },
    delete: async (key, opts, scope) => {
      const result = await adapter.delete(lookup(key), opts, scope);
      record(scope, 'delete', result);
      return result;
    },
    list: (query, scope) => adapter.list({ ...query, filters: filters(query.filters) }, scope),
  };
  if (adapter.aggregate)
    wrapped.aggregate = (spec, scope) =>
      adapter.aggregate!({ ...spec, filters: filters(spec.filters ?? []) }, scope);
  if (adapter.search)
    wrapped.search = (spec, scope) =>
      adapter.search!({ ...spec, filters: filters(spec.filters ?? []) }, scope);
  if (adapter.restore)
    wrapped.restore = async (key, scope) => {
      const row = await adapter.restore!(lookup(key), scope);
      record(scope, 'restore', row);
      return row;
    };
  if (adapter.createMany)
    wrapped.createMany = async (rows, scope) => {
      const result = await adapter.createMany!(
        rows.map((row) => input(row, true)),
        scope,
      );
      result.forEach((row) => record(scope, 'create', row));
      return result;
    };
  if (adapter.updateWhere)
    wrapped.updateWhere = async (query, patch, scope) => {
      const result = await adapter.updateWhere!(filters(query), input(patch), scope);
      result.records?.forEach((row) => record(scope, 'update', row));
      if (!result.records && result.count > 0 && cfg.afterCommit)
        events.get(scope)?.push(Object.freeze({ operation: 'updateMany', count: result.count }));
      return result;
    };
  if (adapter.upsertOne)
    wrapped.upsertOne = async (spec, scope) => {
      if ((condition || Object.keys(fixed).length) && !adapter.capabilities.has('scopedUpsert'))
        throw new CrudException('Scoped native upsert is not supported', 400, 'UPSERT_UNSUPPORTED');
      const result = await adapter.upsertOne!(
        { ...spec, values: input(spec.values, true), scope: filters(spec.scope ?? []) },
        scope,
      );
      record(scope, 'upsert', result.row);
      return result;
    };
  // Validate response contracts after authorization/field masking, at each row boundary.
  const model =
    cfg.authorization && base.model.relations
      ? {
          ...base.model,
          relations: Object.fromEntries(
            Object.entries(base.model.relations).map(([name, relation]) => [
              name,
              relation.target === base.model.tableName
                ? {
                    ...relation,
                    response: { ...relation.response, authorization: cfg.authorization },
                  }
                : relation,
            ]),
          ),
        }
      : base.model;
  const resource: CrudResource = { ...base, model, config: { ...cfg, model, adapter: wrapped } };
  return { resource, request: req };
}

export async function responseContract(resource: CrudResource, row: Row): Promise<Row> {
  const schema = resource.config.contracts?.response ?? resource.model.contracts?.response;
  if (!schema) return row;
  const value = await validateSchema(schema, row);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Response contract must produce a record');
  return Object.fromEntries(Object.entries(value));
}
export async function projectPage(
  resource: CrudResource,
  request: EngineRequest,
  rows: Row[],
): Promise<Row[]> {
  if (!resource.config.projectPage || !rows.length) return rows;
  const additions = await resource.config.projectPage(
    rows.map((row) => Object.freeze({ ...row })),
    buildHookContext(request, { tx: undefined }),
  );
  if (additions.length !== rows.length)
    throw new TypeError('Page projection must preserve row count');
  return rows.map((row, index) => {
    const extra = additions[index]!;
    if (Object.keys(extra).some((key) => Object.hasOwn(row, key)))
      throw new TypeError('Page projections cannot overwrite persisted fields');
    return { ...row, ...extra };
  });
}
