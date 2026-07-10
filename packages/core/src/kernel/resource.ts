/**
 * `defineResource` compiles a model + adapter + per-resource configuration
 * into a `CrudResource`: derived body schemas, loud definition-time capability
 * checks, and per-verb executors. The Vela integration layer consumes the
 * compiled resource through `execute()` — one seam between HTTP and engine.
 */

import type { ZodObject, ZodRawShape } from 'zod';
import { assertAdapterSatisfies, type CapabilityRequirement } from '../adapter/capabilities';
import type { CrudAdapter } from '../adapter/contract';
import type { FilterConfig, SortSpec } from '../adapter/query-types';
import type { AggregateBuildConfig } from '../query/aggregate';
import type { SearchFieldConfig } from '../query/search';
import { ConfigurationException } from '../envelope/errors';
import { defaultEnvelope, type ErrorMapper, type ResponseEnvelope } from '../envelope/envelope';
import { resolveStructuredError } from '../envelope/mappers';
import { deriveCreateSchema, deriveUpdateSchema } from '../model/schema-derive';
import type { Model } from '../model/model.types';
import type { VersioningStore } from '../versioning/index';
import type { AuditStore } from '../audit/index';
import type { CrudEndpointName } from '../verb-table';
import { EXTENDED_EXECUTORS } from './extended/registry';
import type { CrudHooks, HookModeConfig } from './hook-types';
import type { EngineRequest, EngineResult } from './engine-request';
import { executeCreate, executeDelete, executeList, executeRead, executeUpdate } from './verbs';

export type CoreVerb = 'create' | 'read' | 'update' | 'delete' | 'list';

export interface ResourcePaginationConfig {
  defaultPerPage?: number;
  maxPerPage?: number;
  cursor?: { enabled: boolean; field?: string };
}

export interface ResourceConfig<Row extends Record<string, unknown> = Record<string, unknown>> {
  model: Model;
  adapter: CrudAdapter<Row>;
  hooks?: CrudHooks<Row> & HookModeConfig;
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
  envelope?: ResponseEnvelope;
  errorMappers?: ErrorMapper[];
}

export interface CrudResource<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly name: string;
  readonly model: Model;
  readonly config: ResourceConfig<Row>;
  /** Derived (or dto-overridden) request body schemas — the DTO bridge. */
  readonly createSchema: ZodObject<ZodRawShape>;
  readonly updateSchema: ZodObject<ZodRawShape>;
  execute(verb: CrudEndpointName, req: EngineRequest): Promise<EngineResult>;
}

/** Derives the capability demands a resource config places on its adapter. */
export function deriveCapabilityRequirements(
  config: ResourceConfig<never>,
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
  return requirements;
}

export function defineResource<Row extends Record<string, unknown>>(
  name: string,
  config: ResourceConfig<Row>,
): CrudResource<Row> {
  assertAdapterSatisfies(
    name,
    deriveCapabilityRequirements(config as ResourceConfig<never>),
    config.adapter as CrudAdapter<never>,
  );
  if ((config.allowedIncludes?.length ?? 0) > 0 && config.adapter.relations === undefined) {
    throw new ConfigurationException(
      `Resource '${name}': allowedIncludes configured but the adapter has no relation loader`,
    );
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
    const pk = config.model.primaryKeys[0] ?? 'id';
    if (!(pk in config.dto.create.shape)) {
      throw new ConfigurationException(
        `Resource '${name}': id:'client' requires the custom dto.create to include the primary key '${pk}'`,
      );
    }
  }

  const createSchema = config.dto?.create ?? deriveCreateSchema(config.model);
  const updateSchema =
    config.dto?.update ?? deriveUpdateSchema(config.model, config.updateFields ?? {});

  const resource: CrudResource<Row> = {
    name,
    model: config.model,
    config,
    createSchema,
    updateSchema,
    async execute(verb: CrudEndpointName, req: EngineRequest): Promise<EngineResult> {
      // Executors operate on the type-erased resource (rows are records
      // internally); the generic is a compile-time convenience for callers.
      const erased = resource as unknown as import('./verbs').AnyResource;
      try {
        switch (verb) {
          case 'create':
            return await executeCreate(erased, req);
          case 'read':
            return await executeRead(erased, req);
          case 'update':
            return await executeUpdate(erased, req);
          case 'delete':
            return await executeDelete(erased, req);
          case 'list':
            return await executeList(erased, req);
          default: {
            const executor = EXTENDED_EXECUTORS[verb];
            if (!executor) {
              throw new ConfigurationException(
                `Verb '${verb}' is not implemented by the native engine yet`,
              );
            }
            return await executor(erased, req);
          }
        }
      } catch (error) {
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
    },
  };
  return resource;
}

/** The resource's active envelope (custom or the canonical default). */
export function envelopeOf<Row extends Record<string, unknown>>(
  resource: CrudResource<Row>,
): ResponseEnvelope {
  return resource.config.envelope ?? defaultEnvelope;
}
