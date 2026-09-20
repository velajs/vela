/**
 * The closed op catalog: the single source of truth for the Studio RPC surface.
 *
 * `StudioRpcMap` names every op with its `req`/`res` types; `StudioOp` is the op
 * union; `STUDIO_OPS` is the runtime const array; `STUDIO_OP_META` classifies
 * each op for dispatch (read/write), feature negotiation, write-gating, and
 * destructive-confirm handling.
 *
 * Breaking changes increment STUDIO_PROTOCOL_VERSION and update all consumers.
 */
import type { StudioCapabilities, StudioFeatureKey, StudioWriteGates } from './capabilities';
import type {
  CascadePreviewRequest,
  CascadePreviewResponse,
  ClearTableRequest,
  DeleteRowsRequest,
  FacetsRequest,
  FacetsResponse,
  GenerateRowsRequest,
  GenerateRowsResponse,
  ListRowsRequest,
  StudioModelDescriptor,
  StudioModelInfo,
  StudioRowPage,
  WriteRowRequest,
} from './data';
import type { EntrypointRow, ModuleNode, RouteRow, TryItRequest } from './app';
import type {
  AdminAuditEntry,
  AdminLogEntry,
  AuthOrgRow,
  AuthSessionRow,
  AuthUserDetail,
  AuthUserRow,
  CronTriggerRow,
  DlqEntryRow,
  FlagEvaluation,
  FlagRow,
  LiveSubscriptionRow,
  PresenceRoomRow,
  QueueDepthRow,
  QueueRow,
  ScheduleJobRow,
  TransferExportResult,
  TransferImportRequest,
  TransferImportResult,
} from './panels';
import type {
  RestoreOutcome,
  RestorePreview,
  RestoreRequest,
  RestoreTarget,
  RetentionPolicy,
  TimeTravelCapabilities,
  TimeTravelMark,
  TimeTravelMarkPage,
  TimeTravelScope,
} from './time-travel';

/** A request that carries no arguments. */
export type EmptyArgs = Record<string, never>;

/**
 * The closed catalog of every Studio op, keyed by op name. Each entry declares
 * its `req` (dispatch args) and `res` (result) type.
 */
export interface StudioRpcMap {
  // capability negotiation
  'studio.capabilities': { req: EmptyArgs; res: StudioCapabilities };

  // application introspection
  'app.routes': { req: EmptyArgs; res: RouteRow[] };
  'app.modules': { req: EmptyArgs; res: ModuleNode[] };
  'app.entrypoints': { req: EmptyArgs; res: EntrypointRow[] };
  'app.openapi': { req: EmptyArgs; res: unknown };
  'api.authorizeTryIt': { req: TryItRequest; res: { authorized: true } };

  // data browser
  'data.listModels': { req: EmptyArgs; res: StudioModelInfo[] };
  'data.describeModel': { req: { model: string }; res: StudioModelDescriptor };
  'data.listRows': { req: ListRowsRequest; res: StudioRowPage };
  'data.readRow': { req: { model: string; id: string }; res: Record<string, unknown> | null };
  'data.facets': { req: FacetsRequest; res: FacetsResponse };
  'data.cascadePreview': { req: CascadePreviewRequest; res: CascadePreviewResponse };
  'data.writeRow': { req: WriteRowRequest; res: Record<string, unknown> };
  'data.deleteRows': { req: DeleteRowsRequest; res: { deleted: number } };
  'data.clearTable': { req: ClearTableRequest; res: { deleted: number } };
  'data.generateRows': { req: GenerateRowsRequest; res: GenerateRowsResponse };

  // time travel
  'timeTravel.capabilities': { req: { scope?: TimeTravelScope }; res: TimeTravelCapabilities };
  'timeTravel.currentMark': { req: { scope?: TimeTravelScope }; res: TimeTravelMark };
  'timeTravel.markForTime': {
    req: { time: number | string; scope?: TimeTravelScope };
    res: TimeTravelMark | null;
  };
  'timeTravel.listMarks': {
    req: { scope?: TimeTravelScope; limit?: number; before?: string };
    res: TimeTravelMarkPage;
  };
  'timeTravel.preview': {
    req: { target: RestoreTarget; scope?: TimeTravelScope };
    res: RestorePreview;
  };
  'timeTravel.armRestore': { req: RestoreRequest; res: RestoreOutcome };
  'timeTravel.undo': {
    req: { undoMark: string; scope?: TimeTravelScope; confirmToken: string };
    res: RestoreOutcome;
  };
  'timeTravel.createSnapshot': {
    req: { scope?: TimeTravelScope; label?: string };
    res: TimeTravelMark;
  };
  'timeTravel.prune': {
    req: { retention: RetentionPolicy; scope?: TimeTravelScope; confirmToken: string };
    res: { pruned: number };
  };

  // transfer (export / import)
  'transfer.export': { req: { model?: string }; res: TransferExportResult };
  'transfer.import': { req: TransferImportRequest; res: TransferImportResult };

  // auth
  'auth.users': {
    req: { q?: string; cursor?: string };
    res: { rows: AuthUserRow[]; nextCursor?: string };
  };
  'auth.userDetail': { req: { id: string }; res: AuthUserDetail };
  'auth.sessions': { req: { userId?: string }; res: AuthSessionRow[] };
  'auth.revokeSession': { req: { sessionId: string }; res: { ok: true } };
  'auth.organizations': { req: EmptyArgs; res: AuthOrgRow[] };

  // queue
  'queue.list': { req: EmptyArgs; res: QueueRow[] };
  'queue.depths': { req: EmptyArgs; res: QueueDepthRow[] };
  'queue.dlq': { req: { queue: string }; res: DlqEntryRow[] };
  'queue.send': { req: { queue: string; payload: unknown }; res: { id: string } };
  'queue.replay': { req: { queue: string; ids: string[] }; res: { replayed: number } };

  // schedule
  'schedule.jobs': { req: EmptyArgs; res: ScheduleJobRow[] };
  'schedule.triggers': { req: EmptyArgs; res: CronTriggerRow[] };
  'schedule.runNow': { req: { id: string }; res: { ok: true } };

  // flags
  'flags.list': { req: EmptyArgs; res: FlagRow[] };
  'flags.evaluate': {
    req: { key: string; context?: Record<string, unknown> };
    res: FlagEvaluation;
  };

  // observability
  'logs.tail': { req: { level?: AdminLogEntry['level']; limit?: number }; res: AdminLogEntry[] };
  'live.subscriptions': { req: EmptyArgs; res: LiveSubscriptionRow[] };
  'presence.rooms': { req: EmptyArgs; res: PresenceRoomRow[] };
  'audit.tail': { req: { limit?: number }; res: AdminAuditEntry[] };
}

/** The union of every op name. */
export type StudioOp = keyof StudioRpcMap;

/** The `req` type for an op. */
export type StudioOpReq<Op extends StudioOp> = StudioRpcMap[Op]['req'];

/** The `res` type for an op. */
export type StudioOpRes<Op extends StudioOp> = StudioRpcMap[Op]['res'];

/**
 * Runtime classification of a single op. Single source for dispatch
 * (read/write), capability negotiation (`feature`), write-gating (`gate`), and
 * destructive-confirm handling (`destructive`).
 */
export interface StudioOpMeta {
  mode: 'read' | 'write';
  feature: StudioFeatureKey;
  gate?: keyof StudioWriteGates;
  destructive?: true;
}

/**
 * Op meta for every op. `as const satisfies` enforces total key coverage while
 * preserving literal types (so `destructive` narrows exactly), which drives the
 * type-level destructive-confirm guard in the tests.
 */
export const STUDIO_OP_META = {
  'studio.capabilities': { mode: 'read', feature: 'app' },

  'app.routes': { mode: 'read', feature: 'app' },
  'app.modules': { mode: 'read', feature: 'app' },
  'app.entrypoints': { mode: 'read', feature: 'app' },
  'app.openapi': { mode: 'read', feature: 'openapi' },
  /** Authorizes a host HTTP request; server gates and audits this operational action. */
  'api.authorizeTryIt': { mode: 'write', feature: 'openapi', gate: 'opsEditable' },

  'data.listModels': { mode: 'read', feature: 'data' },
  'data.describeModel': { mode: 'read', feature: 'data' },
  'data.listRows': { mode: 'read', feature: 'data' },
  'data.readRow': { mode: 'read', feature: 'data' },
  'data.facets': { mode: 'read', feature: 'data' },
  'data.cascadePreview': { mode: 'read', feature: 'data' },
  'data.writeRow': { mode: 'write', feature: 'data', gate: 'dataEditable' },
  'data.deleteRows': { mode: 'write', feature: 'data', gate: 'dataEditable', destructive: true },
  'data.clearTable': { mode: 'write', feature: 'data', gate: 'dataEditable', destructive: true },
  'data.generateRows': { mode: 'write', feature: 'data', gate: 'dataEditable' },

  'timeTravel.capabilities': { mode: 'read', feature: 'timeTravel' },
  'timeTravel.currentMark': { mode: 'read', feature: 'timeTravel' },
  'timeTravel.markForTime': { mode: 'read', feature: 'timeTravel' },
  'timeTravel.listMarks': { mode: 'read', feature: 'timeTravel' },
  'timeTravel.preview': { mode: 'read', feature: 'timeTravel' },
  'timeTravel.armRestore': {
    mode: 'write',
    feature: 'timeTravel',
    gate: 'timeTravelRestore',
    destructive: true,
  },
  'timeTravel.undo': {
    mode: 'write',
    feature: 'timeTravel',
    gate: 'timeTravelRestore',
    destructive: true,
  },
  'timeTravel.createSnapshot': { mode: 'write', feature: 'timeTravel' },
  'timeTravel.prune': {
    mode: 'write',
    feature: 'timeTravel',
    gate: 'timeTravelRestore',
    destructive: true,
  },

  'transfer.export': { mode: 'read', feature: 'transfer' },
  'transfer.import': {
    mode: 'write',
    feature: 'transfer',
    gate: 'transferImport',
    destructive: true,
  },

  'auth.users': { mode: 'read', feature: 'auth' },
  'auth.userDetail': { mode: 'read', feature: 'auth' },
  'auth.sessions': { mode: 'read', feature: 'auth' },
  'auth.revokeSession': { mode: 'write', feature: 'auth', gate: 'opsEditable' },
  'auth.organizations': { mode: 'read', feature: 'authOrganizations' },

  'queue.list': { mode: 'read', feature: 'queue' },
  'queue.depths': { mode: 'read', feature: 'queue' },
  'queue.dlq': { mode: 'read', feature: 'queue' },
  'queue.send': { mode: 'write', feature: 'queue', gate: 'opsEditable' },
  'queue.replay': { mode: 'write', feature: 'queue', gate: 'opsEditable' },

  'schedule.jobs': { mode: 'read', feature: 'schedule' },
  'schedule.triggers': { mode: 'read', feature: 'schedule' },
  'schedule.runNow': { mode: 'write', feature: 'schedule', gate: 'opsEditable' },

  'flags.list': { mode: 'read', feature: 'flags' },
  'flags.evaluate': { mode: 'read', feature: 'flags' },

  'logs.tail': { mode: 'read', feature: 'logs' },
  'live.subscriptions': { mode: 'read', feature: 'live' },
  'presence.rooms': { mode: 'read', feature: 'presence' },
  'audit.tail': { mode: 'read', feature: 'audit' },
} as const satisfies Record<StudioOp, StudioOpMeta>;

/**
 * Every op name as a runtime const array. Kept as a literal tuple (via
 * `as const satisfies`) so the exhaustiveness drift guard can compare its
 * element union against `keyof StudioRpcMap` in both directions.
 */
export const STUDIO_OPS = [
  'studio.capabilities',
  'app.routes',
  'app.modules',
  'app.entrypoints',
  'app.openapi',
  'api.authorizeTryIt',
  'data.listModels',
  'data.describeModel',
  'data.listRows',
  'data.readRow',
  'data.facets',
  'data.cascadePreview',
  'data.writeRow',
  'data.deleteRows',
  'data.clearTable',
  'data.generateRows',
  'timeTravel.capabilities',
  'timeTravel.currentMark',
  'timeTravel.markForTime',
  'timeTravel.listMarks',
  'timeTravel.preview',
  'timeTravel.armRestore',
  'timeTravel.undo',
  'timeTravel.createSnapshot',
  'timeTravel.prune',
  'transfer.export',
  'transfer.import',
  'auth.users',
  'auth.userDetail',
  'auth.sessions',
  'auth.revokeSession',
  'auth.organizations',
  'queue.list',
  'queue.depths',
  'queue.dlq',
  'queue.send',
  'queue.replay',
  'schedule.jobs',
  'schedule.triggers',
  'schedule.runNow',
  'flags.list',
  'flags.evaluate',
  'logs.tail',
  'live.subscriptions',
  'presence.rooms',
  'audit.tail',
] as const satisfies readonly StudioOp[];

/**
 * The subset of ops flagged destructive (they carry a `confirmToken`). Derived
 * from the op union so it can't drift from {@link STUDIO_OP_META}.
 */
export type DestructiveStudioOp = {
  [K in StudioOp]: (typeof STUDIO_OP_META)[K] extends { destructive: true } ? K : never;
}[StudioOp];
