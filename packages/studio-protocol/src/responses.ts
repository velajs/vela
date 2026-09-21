import { z } from 'zod';
import { STUDIO_FEATURE_KEYS } from './capabilities';
import { STUDIO_OPS, STUDIO_OP_META } from './ops';
import type { StudioOp, StudioOpRes } from './ops';
import type { AdminRpcResponse } from './envelope';
import type { StudioInvocationDiagnostic } from './panels';

const row = z.record(z.string(), z.unknown());
const strings = z.array(z.string());
const providerScope = z.enum(['singleton', 'transient', 'request']);
const invocationDiagnostic = z.object({
  kind: z.string(),
  source: z.string(),
  moduleId: z.string().optional(),
  invocationId: z.string().optional(),
  elapsedMs: z.number().nonnegative(),
  outcome: z.enum(['returned', 'threw']),
  boundary: z.literal('handler'),
});

/** Validate a structured log detail before promoting it to invocation diagnostics. */
export function parseStudioInvocationDiagnostic(value: unknown): StudioInvocationDiagnostic {
  return invocationDiagnostic.parse(value);
}
const timeTravelCapabilities = z.object({
  markByTime: z.boolean(),
  list: z.boolean(),
  undo: z.boolean(),
  inPlace: z.boolean(),
  restartRequired: z.boolean(),
  portableExport: z.boolean(),
  createOnDemand: z.boolean(),
  granularity: z.enum(['bookmark', 'snapshot', 'snapshot+cdc']),
  scopeNote: z.string(),
});
const mark = z.object({
  id: z.string(),
  kind: z.enum(['bookmark', 'snapshot']),
  time: z.number().optional(),
  label: z.string().optional(),
  schemaHash: z.string().optional(),
  sizeBytes: z.number().optional(),
  tables: strings.optional(),
});
const restoreOutcome = z.object({
  restoredTo: z.string(),
  undoMark: mark.optional(),
  applied: z.boolean(),
  restartRequested: z.boolean(),
});
const user = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().optional(),
  emailVerified: z.boolean(),
  image: z.string().optional(),
  role: z.string().optional(),
  banned: z.boolean().optional(),
  createdAt: z.number(),
});
const session = z.object({
  id: z.string(),
  userId: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  ipAddress: z.string().optional(),
  userAgent: z.string().optional(),
});
const organization = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string().optional(),
  memberCount: z.number().optional(),
  createdAt: z.number(),
});
const flagValue = z.union([z.boolean(), z.string(), z.number(), row, z.array(z.unknown())]);
const deleted = z.object({ deleted: z.number() });
const acknowledged = z.object({ ok: z.literal(true) });

/** Every operation must supply a concrete validator for its declared output. */
export const STUDIO_RESPONSE_PARSERS: {
  readonly [Op in StudioOp]: (value: unknown) => StudioOpRes<Op>;
} = {
  'studio.capabilities': z.object({
    operations: z.array(z.enum(STUDIO_OPS)),
    features: z.record(z.enum(STUDIO_FEATURE_KEYS), z.boolean()),
    writes: z.object({
      dataEditable: z.boolean(),
      schemaEditable: z.boolean(),
      opsEditable: z.boolean(),
      runAsIdentity: z.boolean(),
      timeTravelRestore: z.boolean(),
      transferImport: z.boolean(),
    }),
    timeTravel: timeTravelCapabilities.nullable(),
  }).parse,
  'app.routes': z.array(
    z.object({
      method: z.string(),
      path: z.string(),
      handler: z.string(),
      source: z.enum(['controller', 'mounted']),
      moduleId: z.string().optional(),
    }),
  ).parse,
  'app.modules': z.array(
    z.object({
      moduleId: z.string(),
      imports: strings,
      isGlobal: z.boolean(),
      lazy: z.boolean(),
      providers: strings,
      exports: strings,
      providerScopes: z.array(z.object({ token: z.string(), scope: providerScope })).optional(),
    }),
  ).parse,
  'app.entrypoints': z.array(
    z.object({
      kind: z.string(),
      target: z.string(),
      meta: z.unknown().optional(),
      moduleId: z.string().optional(),
      scope: providerScope.optional(),
    }),
  ).parse,
  'app.openapi': z.unknown().parse,
  'api.authorizeTryIt': z.object({ authorized: z.literal(true) }).parse,
  'data.listModels': z.array(
    z.object({
      name: z.string(),
      table: z.string(),
      label: z.string(),
      capabilities: strings,
      database: z.string().optional(),
    }),
  ).parse,
  'data.describeModel': z.object({
    name: z.string(),
    table: z.string(),
    primaryKeys: strings,
    database: z.string().optional(),
    columns: z.array(
      z.object({
        name: z.string(),
        type: z.enum(['string', 'number', 'boolean', 'date', 'json', 'unknown']),
        pk: z.boolean(),
        nullable: z.boolean(),
        unique: z.boolean(),
        managed: z.boolean(),
        fk: z.object({ table: z.string(), relation: z.string() }).optional(),
      }),
    ),
    relations: z.array(
      z.object({
        name: z.string(),
        type: z.enum(['hasOne', 'hasMany', 'belongsTo']),
        target: z.string(),
        foreignKey: z.string(),
        cascade: z.string().optional(),
      }),
    ),
    flags: z.object({
      softDelete: z.boolean(),
      multiTenant: z.boolean(),
      versioning: z.boolean(),
      audit: z.boolean(),
    }),
    supports: z.object({
      bulkWrites: z.boolean(),
      facets: z.boolean(),
      search: z.boolean(),
      cascade: z.boolean(),
    }),
  }).parse,
  'data.listRows': z.object({
    rows: z.array(row),
    info: z.object({
      page: z.number(),
      per_page: z.number(),
      total_count: z.number().optional(),
      total_pages: z.number().optional(),
      has_next_page: z.boolean(),
      has_prev_page: z.boolean(),
      next_cursor: z.string().optional(),
    }),
  }).parse,
  'data.readRow': row.nullable().parse,
  'data.facets': z.object({ buckets: z.array(z.object({ value: z.unknown(), count: z.number() })) })
    .parse,
  'data.cascadePreview': z.object({
    relations: z.array(
      z.object({
        relation: z.string(),
        target: z.string(),
        action: z.string(),
        affected: z.number(),
      }),
    ),
  }).parse,
  'data.writeRow': row.parse,
  'data.deleteRows': deleted.parse,
  'data.clearTable': deleted.parse,
  'data.generateRows': z.object({ inserted: z.number() }).parse,
  'timeTravel.capabilities': timeTravelCapabilities.parse,
  'timeTravel.currentMark': mark.parse,
  'timeTravel.markForTime': mark.nullable().parse,
  'timeTravel.listMarks': z.object({ marks: z.array(mark), nextCursor: z.string().optional() })
    .parse,
  'timeTravel.preview': z.object({
    target: mark,
    affectedTables: z.array(z.object({ table: z.string(), approxRows: z.number().optional() })),
    schemaCompatible: z.boolean(),
    incompatibleTables: strings,
    undoAvailable: z.boolean(),
    restartRequired: z.boolean(),
    confirmToken: z.string(),
    expiresAt: z.number(),
  }).parse,
  'timeTravel.armRestore': restoreOutcome.parse,
  'timeTravel.undo': restoreOutcome.parse,
  'timeTravel.createSnapshot': mark.parse,
  'timeTravel.prune': z.object({ pruned: z.number() }).parse,
  'transfer.export': z.object({ exportUrl: z.string() }).parse,
  'transfer.import': z.object({
    imported: z.number(),
    errors: z.array(z.object({ line: z.number(), message: z.string() })),
  }).parse,
  'auth.users': z.object({ rows: z.array(user), nextCursor: z.string().optional() }).parse,
  'auth.userDetail': z.object({
    user,
    sessions: z.array(session),
    organizations: z.array(organization),
  }).parse,
  'auth.sessions': z.array(session).parse,
  'auth.revokeSession': acknowledged.parse,
  'auth.organizations': z.array(organization).parse,
  'queue.list': z.array(
    z.object({ name: z.string(), kind: z.string(), depth: z.number().optional() }),
  ).parse,
  'queue.depths': z.array(
    z.object({ name: z.string(), depth: z.number(), inFlight: z.number().optional() }),
  ).parse,
  'queue.dlq': z.array(
    z.object({
      id: z.string(),
      queue: z.string(),
      failedAt: z.number(),
      attempts: z.number(),
      error: z.string().optional(),
      payload: z.unknown().optional(),
    }),
  ).parse,
  'queue.send': z.object({ id: z.string() }).parse,
  'queue.replay': z.object({ replayed: z.number() }).parse,
  'schedule.jobs': z.array(
    z.object({
      name: z.string(),
      kind: z.enum(['cron', 'interval']),
      expression: z.string().optional(),
      ms: z.number().optional(),
      lastRun: z.number().optional(),
      nextRun: z.number().optional(),
    }),
  ).parse,
  'schedule.triggers': z.array(
    z.object({ name: z.string(), cron: z.string(), nextRun: z.number().optional() }),
  ).parse,
  'schedule.runNow': acknowledged.parse,
  'flags.list': z.array(z.object({ key: z.string(), value: flagValue })).parse,
  'flags.evaluate': z.object({
    flagKey: z.string(),
    value: flagValue,
    reason: z.enum(['STATIC', 'DEFAULT', 'ERROR']),
    errorMessage: z.string().optional(),
  }).parse,
  'logs.tail': z.array(
    z.object({
      ts: z.number(),
      level: z.enum(['debug', 'info', 'warn', 'error']),
      msg: z.string(),
      source: z.string().optional(),
      fields: row.optional(),
      invocation: invocationDiagnostic.optional(),
    }),
  ).parse,
  'live.subscriptions': z.array(
    z.object({
      id: z.string(),
      room: z.string(),
      tags: strings,
      connectedAt: z.number(),
      clientId: z.string().optional(),
    }),
  ).parse,
  'presence.rooms': z.array(
    z.object({ room: z.string(), count: z.number(), members: strings.optional() }),
  ).parse,
  'audit.tail': z.array(
    z.object({
      ts: z.number(),
      op: z.string(),
      mode: z.enum(['read', 'write']),
      subject: z.string(),
      status: z.number(),
      ms: z.number(),
      ip: z.string().nullable(),
      detail: z
        .object({
          target: z.string().optional(),
          summary: z.string().optional(),
          extra: row.optional(),
        })
        .optional(),
    }),
  ).parse,
};

/** The result type comes only from the selected operation and its validator. */
export function parseStudioResponse<Op extends StudioOp>(op: Op, value: unknown): StudioOpRes<Op> {
  return STUDIO_RESPONSE_PARSERS[op](value);
}

const errorStatus = z.number().int().min(400).max(599);
const envelope = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    op: z.string(),
    data: z.unknown(),
    meta: z.object({ ms: z.number(), op: z.string(), mode: z.enum(['read', 'write']) }),
  }),
  z.object({
    ok: z.literal(false),
    op: z.string(),
    status: errorStatus,
    error: z.object({
      code: z.string(),
      title: z.string(),
      status: errorStatus,
      message: z.string(),
      hint: z.string().optional(),
      docsUrl: z.string().optional(),
      details: z.unknown().optional(),
    }),
  }),
]);

/** Validate the envelope, operation identity, and operation-specific payload. */
export function parseStudioRpcResponse<Op extends StudioOp>(
  op: Op,
  value: unknown,
): AdminRpcResponse<StudioOpRes<Op>> {
  const parsed = envelope.parse(value);
  if (parsed.op !== op) throw new Error('Studio response operation does not match the request.');
  if (!parsed.ok) {
    if (parsed.status !== parsed.error.status) throw new Error('Inconsistent Studio error status.');
    return parsed;
  }
  if (parsed.meta.op !== op || parsed.meta.mode !== STUDIO_OP_META[op].mode) {
    throw new Error('Studio response metadata does not match the request.');
  }
  return { ...parsed, data: parseStudioResponse(op, parsed.data) };
}
