import { historyTenantNamespace } from '../versioning/index';
import { parseSchemaAsync } from '@velajs/vela/validation';
import { AtomicBatchResultError, requireAtomicBatch } from '../adapter/atomic';
import { ConfigurationException, NotFoundException } from '../envelope/errors';
import { applyManagedInsertFields, applyManagedUpdateFields } from '../model/managed-fields';
import type { EngineRequest, EngineResult } from './engine-request';
import { envelopeOf, type RuntimeResourceConfig, type CoreVerb } from './resource';
import {
  assertCreateAllowed,
  buildLookup,
  buildPolicyContext,
  createSchemaFor,
  parseBody,
  rowIdentifier,
  shapeOne,
  txCtx,
  updateSchemaFor,
  type AnyResource,
} from './verb-helpers';

export function assertAtomicAuditConfig(config: RuntimeResourceConfig): void {
  if (
    config.auditPersistence !== undefined &&
    config.auditPersistence.mode !== 'postCommit' &&
    config.auditPersistence.mode !== 'transaction' &&
    config.auditPersistence.mode !== 'atomic'
  )
    throw new ConfigurationException('Unknown audit persistence mode');
  if (config.auditPersistence?.mode !== 'atomic') return;
  const driver = requireAtomicBatch(config.adapter);
  if (!config.model.audit || config.auditPersistence.snapshots !== 'none')
    throw new ConfigurationException('Atomic auditing requires model.audit and snapshots: none');
  const audit = config.auditStore?.atomic;
  if (!audit || typeof audit.prepare !== 'function' || audit.owner !== driver.owner)
    throw new ConfigurationException(
      'Atomic auditing requires a store on the exact same native database handle',
    );
  if (
    config.model.id === 'database' ||
    config.model.versioning ||
    config.etag ||
    config.model.policies?.write ||
    Object.entries(config.hooks ?? {}).some(
      ([key, hook]) =>
        hook && /^(before|after)(Create|Update|Delete|Restore|Upsert|Batch)/.test(key),
    ) ||
    Object.values(config.model.relations ?? {}).some(
      (relation) => relation.nestedWrites || relation.cascade,
    )
  )
    throw new ConfigurationException(
      'Atomic auditing does not support database-generated IDs, versioning, ETags, mutation hooks, row write policies, nested writes or cascades',
    );
}

/** Identity/context auditing without an outside previous-record read. */
export async function executeAtomicAuditedMutation(
  resource: AnyResource,
  req: EngineRequest,
  verb: Extract<CoreVerb, 'create' | 'update' | 'delete'>,
): Promise<EngineResult> {
  assertAtomicAuditConfig(resource.config);
  if (req.transaction)
    throw new ConfigurationException('Atomic batches cannot join callback transactions');
  const { model, config } = resource;
  const driver = requireAtomicBatch(config.adapter);
  const policy = buildPolicyContext(req);
  const lookup = verb === 'create' ? undefined : buildLookup(resource, req);
  const data =
    verb === 'delete'
      ? undefined
      : await parseBody(
          verb === 'create'
            ? await createSchemaFor(resource, req)
            : await updateSchemaFor(resource, req),
          req.body,
        );
  const input =
    verb === 'create'
      ? applyManagedInsertFields(model, data!, {
          databaseGeneratedId: false,
          tenantId: req.vars?.tenantId,
        })
      : verb === 'update'
        ? applyManagedUpdateFields(model, data!)
        : undefined;
  if (verb === 'create') await assertCreateAllowed(resource, policy, input!);
  const identity =
    verb === 'create' ? input! : { ...lookup!.filters, [lookup!.field]: lookup!.value };
  // Route lookup values are strings. Normalize create identities the same way
  // so compound numeric keys have one stable audit identity across all verbs.
  rowIdentifier(resource, identity); // Validate complete persisted/client keys first.
  const auditIdentity = Object.fromEntries(
    model.primaryKeys.map((field) => [field, String(identity[field])]),
  );
  const audit = config.auditStore!.atomic!.prepare({
    id: crypto.randomUUID(),
    timestamp: new Date(),
    tenantNamespace: historyTenantNamespace(model.tenantField ? req.vars?.tenantId : undefined),
    action: verb,
    tableName: model.tableName,
    recordId: rowIdentifier(resource, auditIdentity),
    ...(req.vars?.userId === undefined ? {} : { userId: req.vars.userId }),
    metadata: {
      snapshots: 'none',
      ...(req.vars?.tenantId === undefined ? {} : { tenantId: req.vars.tenantId }),
    },
  });
  const command =
    verb === 'create'
      ? driver.create(input!, { audit })
      : verb === 'update'
        ? driver.update(lookup!, input!, { audit })
        : driver.delete(lookup!, { softDeleteField: model.softDeleteField }, { audit });
  const [result] = await driver.execute([command], txCtx(req));
  if (result === null) throw new NotFoundException(model.name, lookup?.value);
  let row: Record<string, unknown>;
  try {
    const parsed = await parseSchemaAsync(
      config.contracts?.row ?? model.contracts?.row ?? model.schema.passthrough(),
      result,
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new TypeError('Expected persisted row');
    row = Object.fromEntries(Object.entries(parsed));
  } catch (cause) {
    throw new AtomicBatchResultError(cause);
  }
  return {
    status: verb === 'create' ? 201 : 200,
    body: envelopeOf(resource).success(
      verb === 'delete' ? { deleted: true } : await shapeOne(resource, policy, req, row),
    ),
  };
}
