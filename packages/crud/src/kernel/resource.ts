import { CrudTransactionScope } from './transaction';
import { assertAtomicAuditConfig, executeAtomicAuditedMutation } from './atomic-audit';
import type { CursorCodec } from '../query/cursor-codec';
import { prepareOperation, type AuthorizationPlan, type CommitEvent } from './operation-scope';
import type { PolicyContext } from '../policies/types';
import type { HookContext } from './hook-types';
import type { StandardSchemaV1 } from '@velajs/vela';
import type { CrudContracts } from '../schema/contracts';
/**
 * `defineResource` compiles a model + adapter + per-resource configuration
 * into a `CrudResource`: derived body schemas, loud definition-time capability
 * checks, and per-verb executors. The Vela integration layer consumes the
 * compiled resource through `execute()` — one seam between HTTP and engine.
 */

import type { ZodObject, ZodRawShape } from 'zod';
import { assertAdapterSatisfies, type CapabilityRequirement } from '../adapter/capabilities';
import type { CrudAdapter, RuntimeAdapter } from '../adapter/contract';
import type { FilterConfig, SortSpec } from '../adapter/query-types';
import type { AggregateBuildConfig } from '../query/aggregate';
import type { SearchFieldConfig } from '../query/search';
import { ConfigurationException, ForbiddenException } from '../envelope/errors';
import { defaultEnvelope, type ErrorMapper, type ResponseEnvelope } from '../envelope/envelope';
import { resolveStructuredError } from '../envelope/mappers';
import { deriveCreateSchema, deriveUpdateSchema } from '../model/schema-derive';
import type { Model } from '../model/model.types';
import type { VersioningStore } from '../versioning/index';
import type { AuditStore } from '../audit/index';
import type { CrudEndpointName } from '../verb-table';
import { EXTENDED_EXECUTORS } from './extended/registry';
import type { CrudHooks, HookModeConfig, SchemaHooks } from './hook-types';
import type { EngineRequest, EngineResult } from './engine-request';
import { compileHooks } from './compile-hooks';
import { validateAdapterRows } from './validate-adapter';
import { buildPolicyContext, requireTenantContext } from './verb-helpers';
import { canPerformOperation } from '../policies/evaluate';
import { executeCreate, executeDelete, executeList, executeRead, executeUpdate } from './verbs';

export type CoreVerb = 'create' | 'read' | 'update' | 'delete' | 'list';

export interface ResourcePaginationConfig {
  defaultPerPage?: number;
  maxPerPage?: number;
  cursor?: { enabled: boolean; field?: string; codec?: CursorCodec };
}

export interface RuntimeResourceConfig {
  /** Selected database namespace, when registered through CrudModule. */
  database?: string;
  model: Model;
  contracts?: CrudContracts;
  /** Server-owned mapping from persisted field to parent route parameter. */
  collection?: { parents: Readonly<Record<string, string>> };
  authorization?: (
    context: PolicyContext,
    verb: CrudEndpointName,
  ) => AuthorizationPlan | Promise<AuthorizationPlan>;
  projectPage?: (
    rows: readonly Readonly<Record<string, unknown>>[],
    context: HookContext,
  ) => Promise<readonly Record<string, unknown>[]>;
  afterCommit?: (event: CommitEvent) => void | Promise<void>;
  onAfterCommitError?: (error: unknown, event: CommitEvent) => void | Promise<void>;
  adapter: RuntimeAdapter;
  hooks?: CrudHooks<Record<string, unknown>> & HookModeConfig;
  /** Filterable fields; `filterConfig` narrows operators per field. */
  filterFields?: string[];
  filterConfig?: FilterConfig;
  sortFields?: string[];
  defaultSort?: SortSpec;
  /** Fields the inline `?search=` needle applies to. */
  searchFields?: string[];
  /** Relations exposable via `?include=` (requires an adapter relation loader). */
  allowedIncludes?: string[];
  fieldSelection?: {
    enabled?: boolean;
    allowed?: string[];
    blocked?: string[];
    alwaysInclude?: string[];
    defaults?: string[];
  };
  pagination?: ResourcePaginationConfig;
  /**
   * ETag/If-Match optimistic concurrency (hono-crud `etagEnabled`): read
   * emits a strong content-hash `ETag` (+ 304 on `If-None-Match`), update
   * honors `If-Match` (409 CONFLICT on mismatch — hono-crud parity, not 412).
   * The hashed representation excludes `?fields=` selection and relation
   * embeds (tags stay stable across request variants — a deliberate
   * RFC 7232 purity trade-off) and INCLUDES computed fields: computed
   * functions must be deterministic over the stored row or tags rotate with
   * no write (spurious 409s).
   */
  etag?: boolean;
  /** Insert-or-update conflict target for the upsert family. */
  upsert?: { keys: string[] };
  /** Source fields cleared before a clone insert (model/db defaults reapply). */
  clone?: { fieldsToReset?: string[] };
  /** Batch verb limits (default maxBatchSize follows hono-crud). */
  batch?: { maxBatchSize?: number };
  /** Filtered bulk patch limits + confirmation threshold (X-Confirm-Bulk). */
  bulkPatch?: { maxBulkSize?: number; confirmThreshold?: number; returnRecords?: boolean };
  /** /search weighted-field configuration (falls back to `searchFields`). */
  search?: { fields?: Record<string, SearchFieldConfig> };
  /** /aggregate validation configuration. */
  aggregate?: AggregateBuildConfig;
  /** Body-schema overrides (otherwise derived from the model schema). */
  dto?: { create?: ZodObject<ZodRawShape>; update?: ZodObject<ZodRawShape> };
  updateFields?: { allowed?: string[]; blocked?: string[] };
  /**
   * Version-history store (DI seam) — REQUIRED when `model.versioning` is on.
   * The engine snapshots each versioned mutation here; the version verbs read
   * it back. Decoupled from the data adapter.
   */
  versioningStore?: VersioningStore;
  /**
   * Audit-log store (DI seam) — REQUIRED when `model.audit` is on. The engine
   * writes who/what/when(+field changes) entries here after each mutation.
   * Decoupled from the data adapter.
   */
  auditStore?: AuditStore;
  /** Defaults to postCommit. Atomic mode explicitly omits record snapshots. */
  auditPersistence?: import('../audit/index').AuditPersistence;
  envelope?: ResponseEnvelope;
  errorMappers?: ErrorMapper[];
}

/** Authoring preserves schema-derived hook types; the engine receives a validated runtime view. */
export interface ResourceConfig<Shape extends ZodRawShape = ZodRawShape> extends Omit<
  RuntimeResourceConfig,
  'model' | 'adapter' | 'hooks'
> {
  model: Model<ZodObject<Shape>>;
  adapter: Pick<CrudAdapter, 'runtime'>;
  hooks?: SchemaHooks<Shape>;
}

export interface CrudResource {
  readonly name: string;
  readonly model: Model;
  readonly config: RuntimeResourceConfig;
  /** Derived (or dto-overridden) request body schemas — the DTO bridge. */
  readonly createSchema: StandardSchemaV1;
  readonly updateSchema: StandardSchemaV1;
  execute(verb: CrudEndpointName, req: EngineRequest): Promise<EngineResult>;
}

/** Derives the capability demands a resource config places on its adapter. */
export function deriveCapabilityRequirements(
  config: Pick<RuntimeResourceConfig, 'model' | 'pagination'>,
): CapabilityRequirement[] {
  const requirements: CapabilityRequirement[] = [];
  if (config.pagination?.cursor?.enabled) {
    requirements.push({ capability: 'cursor', reason: 'pagination.cursor.enabled' });
  }
  // id: 'client' intentionally registers NO requirement — the caller supplies
  // the PK, so no adapter generation capability is involved.
  if (config.model.id === 'database') {
    requirements.push({ capability: 'databaseGeneratedId', reason: "model id: 'database'" });
  }
  if (config.model.softDeleteField !== undefined) {
    requirements.push({ capability: 'softDelete', reason: 'model softDelete' });
  }
  if (config.model.unique !== undefined && config.model.unique.length > 0) {
    requirements.push({ capability: 'uniqueConstraints', reason: 'model unique' });
  }
  return requirements;
}

export function defineResource<Shape extends ZodRawShape>(
  name: string,
  config: ResourceConfig<Shape>,
): CrudResource {
  return compileResource(name, {
    ...config,
    adapter: config.adapter.runtime,
    hooks: compileHooks(config.model.schema, config.hooks),
  });
}

/** Internal entry for an already-compiled @Crud configuration. */
export function compileResource(name: string, config: RuntimeResourceConfig): CrudResource {
  config = {
    ...config,
    adapter: validateAdapterRows(
      config.adapter,
      config.contracts?.row ?? config.model.contracts?.row ?? config.model.schema.passthrough(),
    ),
  };
  assertAdapterSatisfies(name, deriveCapabilityRequirements(config), config.adapter);
  assertAtomicAuditConfig(config);
  if ((config.allowedIncludes?.length ?? 0) > 0 && config.adapter.relations === undefined) {
    throw new ConfigurationException(
      `Resource '${name}': allowedIncludes configured but the adapter has no relation loader`,
    );
  }
  for (const include of config.allowedIncludes ?? []) {
    const relation = config.model.relations?.[include];
    if (
      relation !== undefined &&
      relation.target !== config.model.tableName &&
      relation.response === undefined
    ) {
      throw new ConfigurationException(
        `Resource '${name}': included relation '${include}' targets another model but has no ` +
          '`response` authorization metadata. Use defineModels() to auto-wire it, or provide ' +
          '`relation.response` explicitly (an empty object explicitly marks a public target).',
      );
    }
  }
  for (const [relationName, relation] of Object.entries(config.model.relations ?? {})) {
    const nested = relation.nestedWrites;
    const exposesTarget =
      (config.allowedIncludes ?? []).includes(relationName) ||
      nested?.allowCreate === true ||
      nested?.allowUpdate === true ||
      nested?.allowDelete === true ||
      nested?.allowConnect === true ||
      nested?.allowDisconnect === true;
    if (!exposesTarget || relation.target === config.model.tableName) continue;
    if (
      relation.response?.tenantField === undefined ||
      relation.response.softDeleteField === undefined ||
      (nested?.allowCreate === true &&
        (relation.response.primaryKeys === undefined ||
          relation.response.primaryKeys.length === 0 ||
          relation.response.timestamps === undefined))
    ) {
      throw new ConfigurationException(
        `Resource '${name}': relation '${relationName}' targets another model but does not ` +
          'declare target tenant/soft-delete/primary-key/timestamp metadata. Use defineModels() ' +
          'to auto-wire it, or set response.tenantField/softDeleteField/primaryKeys/timestamps ' +
          'explicitly ' +
          '(false means not applicable for tenant and soft-delete fields).',
      );
    }
    const targetShape = relation.schema?.shape;
    for (const field of [
      relation.response.tenantField,
      relation.response.softDeleteField,
      ...(relation.response.primaryKeys ?? []),
    ]) {
      if (
        typeof field === 'string' &&
        targetShape !== undefined &&
        !Object.hasOwn(targetShape, field)
      ) {
        throw new ConfigurationException(
          `Resource '${name}': relation '${relationName}' target metadata references missing field '${field}'`,
        );
      }
    }
  }
  // Loud, never silent: an enabled versioning/audit family without its store
  // seam is a misconfiguration — fail at definition time, not on the first
  // mutation (hono-crud surfaced this as a request-time CONFIGURATION_ERROR;
  // the native engine catches it earlier).
  if (config.model.versioning && config.versioningStore === undefined) {
    throw new ConfigurationException(
      `Resource '${name}': model.versioning is enabled but no versioningStore was provided`,
    );
  }
  if (config.model.audit && config.auditStore === undefined) {
    throw new ConfigurationException(
      `Resource '${name}': model.audit is enabled but no auditStore was provided`,
    );
  }

  // Loud, never silent: under id:'client' the caller must be able to supply
  // the PK on create — a custom dto.create that omits it would brick the
  // create verb at the insert seam (permanent 400) with no authoring signal.
  if (config.model.id === 'client' && config.dto?.create !== undefined) {
    for (const pk of config.model.primaryKeys)
      if (!(pk in config.dto.create.shape)) {
        throw new ConfigurationException(
          `Resource '${name}': id:'client' requires the custom dto.create to include the primary key '${pk}'`,
        );
      }
  }

  const createSchema =
    config.contracts?.create ??
    config.model.contracts?.create ??
    config.dto?.create ??
    deriveCreateSchema(config.model);
  const updateSchema =
    config.contracts?.update ??
    config.model.contracts?.update ??
    config.dto?.update ??
    deriveUpdateSchema(config.model, config.updateFields ?? {});

  const resource: CrudResource = {
    name,
    model: config.model,
    config,
    createSchema,
    updateSchema,
    async execute(verb: CrudEndpointName, req: EngineRequest): Promise<EngineResult> {
      const run = async (): Promise<EngineResult> => {
        try {
          const operation = await prepareOperation(resource, req, verb);
          const scoped = operation.resource;
          req = operation.request;
          requireTenantContext(scoped, req);
          const policies = resource.model.policies;
          if (
            verb === 'aggregate' &&
            policies?.operation === undefined &&
            config.authorization === undefined
          ) {
            throw new ForbiddenException(
              'Aggregate requires an explicit operation authorization policy',
            );
          }
          if (!(await canPerformOperation(buildPolicyContext(req), verb, policies))) {
            throw new ForbiddenException(`Operation '${verb}' is not permitted`);
          }
          if (config.auditPersistence?.mode === 'atomic') {
            if (req.transaction)
              throw new ConfigurationException('Atomic auditing cannot join callback transactions');
            if (verb === 'create' || verb === 'update' || verb === 'delete')
              return await executeAtomicAuditedMutation(scoped, req, verb);
            if (!['read', 'list', 'search', 'aggregate', 'export'].includes(verb))
              throw new ConfigurationException(`Atomic auditing does not support '${verb}'`);
          }
          switch (verb) {
            case 'create':
              return await executeCreate(scoped, req);
            case 'read':
              return await executeRead(scoped, req);
            case 'update':
              return await executeUpdate(scoped, req);
            case 'delete':
              return await executeDelete(scoped, req);
            case 'list':
              return await executeList(scoped, req);
            default: {
              const executor = EXTENDED_EXECUTORS[verb];
              if (!executor) {
                throw new ConfigurationException(
                  `Verb '${verb}' is not implemented by the native engine yet`,
                );
              }
              return await executor(scoped, req);
            }
          }
        } catch (error) {
          if (req.transaction instanceof CrudTransactionScope)
            CrudTransactionScope.fail(req.transaction, error);
          // With a CUSTOM envelope the engine owns error formatting (the
          // envelope's error() shapes the body). Without one, rethrow so the
          // CrudException renders natively through Vela's exception pipeline —
          // its getResponse() already emits the canonical default envelope.
          if (config.envelope !== undefined) {
            const { structured, status } = resolveStructuredError(error, config.errorMappers);
            return { status, body: config.envelope.error(structured) };
          }
          throw error;
        }
      };
      return req.transaction instanceof CrudTransactionScope
        ? CrudTransactionScope.execute(req.transaction, run)
        : run();
    },
  };
  return resource;
}

/** The resource's active envelope (custom or the canonical default). */
export function envelopeOf(resource: CrudResource): ResponseEnvelope {
  return resource.config.envelope ?? defaultEnvelope;
}
