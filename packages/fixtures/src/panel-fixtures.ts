/**
 * Canned fixtures for the package-backed read panels (auth / queue / schedule /
 * flags / logs / live / presence / audit) plus the OpenAPI reference and the
 * `api.tryit` echo. Every value is annotated with a `@velajs/studio-protocol`
 * type, so this module double-guards the wire contract at compile time.
 *
 * This module imports nothing from the other fixture modules; `fixtures.ts`
 * depends on it (one direction), which keeps the fixture graph acyclic.
 */
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
  FlagValue,
  LiveSubscriptionRow,
  PresenceRoomRow,
  QueueDepthRow,
  QueueRow,
  ScheduleJobRow,
} from '@velajs/studio-protocol';
import type { FakeTransportTable } from './fake-transport';

const BASE_TS = 1_700_000_000_000;

// ---- auth ------------------------------------------------------------------

/** Auth users (`auth.users` rows). */
export const authUsers: AuthUserRow[] = [
  {
    id: 'u_ada',
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    emailVerified: true,
    role: 'admin',
    createdAt: 1_699_000_000_000,
  },
  {
    id: 'u_grace',
    email: 'grace@example.com',
    name: 'Grace Hopper',
    emailVerified: false,
    createdAt: 1_699_500_000_000,
  },
  {
    id: 'u_katherine',
    email: 'katherine@example.com',
    name: 'Katherine Johnson',
    emailVerified: true,
    role: 'member',
    banned: true,
    createdAt: 1_699_800_000_000,
  },
];

/** Auth sessions (`auth.sessions`). */
export const authSessions: AuthSessionRow[] = [
  {
    id: 's_1',
    userId: 'u_ada',
    createdAt: BASE_TS,
    expiresAt: BASE_TS + 600_000_000,
    ipAddress: '203.0.113.7',
    userAgent: 'Mozilla/5.0',
  },
  {
    id: 's_2',
    userId: 'u_grace',
    createdAt: BASE_TS + 1_000_000,
    expiresAt: BASE_TS + 700_000_000,
    ipAddress: '198.51.100.4',
  },
];

/** Auth organizations (`auth.organizations`). */
export const authOrganizations: AuthOrgRow[] = [
  {
    id: 'org_acme',
    name: 'Acme, Inc.',
    slug: 'acme',
    memberCount: 3,
    createdAt: 1_698_000_000_000,
  },
  {
    id: 'org_globex',
    name: 'Globex',
    slug: 'globex',
    memberCount: 8,
    createdAt: 1_698_500_000_000,
  },
];

/** Detail view for a single user (`auth.userDetail`). */
export function authUserDetail(id: string): AuthUserDetail {
  const user = authUsers.find((u) => u.id === id) ?? authUsers[0];
  return {
    user,
    sessions: authSessions.filter((s) => s.userId === user.id),
    organizations: authOrganizations.slice(0, 1),
  };
}

// ---- queue -----------------------------------------------------------------

/** Queues (`queue.list`). */
export const queues: QueueRow[] = [
  { name: 'email', kind: 'durable-object', depth: 4 },
  { name: 'reports', kind: 'durable-object', depth: 0 },
  { name: 'webhooks', kind: 'memory', depth: 12 },
];

/** Live queue depths (`queue.depths`). */
export const queueDepths: QueueDepthRow[] = [
  { name: 'email', depth: 4, inFlight: 1 },
  { name: 'reports', depth: 0, inFlight: 0 },
  { name: 'webhooks', depth: 12, inFlight: 3 },
];

/** Dead-letter entries keyed by queue (`queue.dlq`). */
export const dlqByQueue: Record<string, DlqEntryRow[]> = {
  email: [
    {
      id: 'dlq_1',
      queue: 'email',
      failedAt: BASE_TS,
      attempts: 3,
      error: 'SMTP 550: mailbox unavailable',
      payload: { to: 'bad@example.com', template: 'welcome' },
    },
  ],
  webhooks: [
    {
      id: 'dlq_2',
      queue: 'webhooks',
      failedAt: BASE_TS + 500_000,
      attempts: 5,
      error: 'connect ETIMEDOUT',
      payload: { url: 'https://hooks.example.com/x', event: 'order.paid' },
    },
  ],
};

// ---- schedule --------------------------------------------------------------

/** Scheduled jobs (`schedule.jobs`) — exercises the cron/interval kind union. */
export const scheduleJobs: ScheduleJobRow[] = [
  {
    name: 'ReportJob.run',
    kind: 'cron',
    expression: '0 * * * *',
    lastRun: BASE_TS,
    nextRun: BASE_TS + 3_600_000,
  },
  { name: 'HeartbeatJob.ping', kind: 'interval', ms: 30_000 },
];

/** Declared cron triggers (`schedule.triggers`). */
export const scheduleTriggers: CronTriggerRow[] = [
  { name: 'nightly-rollup', cron: '0 2 * * *', nextRun: BASE_TS + 7_200_000 },
  { name: 'weekly-digest', cron: '0 9 * * 1' },
];

// ---- flags -----------------------------------------------------------------

const FLAG_VALUES: Record<string, FlagValue> = {
  'new-dashboard': true,
  'max-upload-mb': 25,
  theme: 'dark',
  rollout: { percent: 50 },
};

/** Feature flags (`flags.list`) — proves `FlagRow.value: FlagValue`, not `enabled`. */
export const flags: FlagRow[] = Object.entries(FLAG_VALUES).map(([key, value]) => ({ key, value }));

/** Evaluate a flag against a context (`flags.evaluate`). */
export function evaluateFlag(key: string): FlagEvaluation {
  if (key === 'broken') {
    return { flagKey: key, value: false, reason: 'ERROR', errorMessage: 'provider threw' };
  }
  const known = Object.prototype.hasOwnProperty.call(FLAG_VALUES, key);
  return known
    ? { flagKey: key, value: FLAG_VALUES[key], reason: 'STATIC' }
    : { flagKey: key, value: false, reason: 'DEFAULT' };
}

// ---- logs ------------------------------------------------------------------

/** Captured application logs (`logs.tail`), newest last. */
export const logs: AdminLogEntry[] = [
  { ts: BASE_TS, level: 'info', msg: 'server started', source: 'bootstrap' },
  { ts: BASE_TS + 1_000, level: 'debug', msg: 'cache warm', source: 'cache', fields: { keys: 12 } },
  { ts: BASE_TS + 2_000, level: 'info', msg: 'GET /users 200', source: 'http', fields: { ms: 8 } },
  {
    ts: BASE_TS + 3_000,
    level: 'warn',
    msg: 'slow query',
    source: 'db',
    fields: { ms: 812, table: 'users' },
  },
  {
    ts: BASE_TS + 4_000,
    level: 'error',
    msg: 'unhandled rejection',
    source: 'worker',
    fields: { err: 'ETIMEDOUT' },
  },
];

// ---- live / presence -------------------------------------------------------

/** Active live subscriptions (`live.subscriptions`). */
export const liveSubscriptions: LiveSubscriptionRow[] = [
  {
    id: 'sub_1',
    room: 'orders',
    tags: ['order:1', 'status:open'],
    connectedAt: BASE_TS,
    clientId: 'c_a',
  },
  { id: 'sub_2', room: 'orders', tags: ['order:2'], connectedAt: BASE_TS + 1_000 },
  {
    id: 'sub_3',
    room: 'chat:general',
    tags: ['room:general'],
    connectedAt: BASE_TS + 2_000,
    clientId: 'c_b',
  },
];

/** Presence room occupancy (`presence.rooms`). */
export const presenceRooms: PresenceRoomRow[] = [
  { room: 'orders', count: 2, members: ['ada', 'grace'] },
  { room: 'chat:general', count: 5, members: ['ada', 'grace', 'katherine', 'linus', 'alan'] },
];

// ---- audit -----------------------------------------------------------------

/** Recorded admin audit rows (`audit.tail`), newest last. */
export const auditEntries: AdminAuditEntry[] = [
  {
    ts: BASE_TS,
    op: 'studio.capabilities',
    mode: 'read',
    subject: 'admin',
    status: 200,
    ms: 2,
    ip: '203.0.113.7',
  },
  {
    ts: BASE_TS + 1_000,
    op: 'data.listRows',
    mode: 'read',
    subject: 'admin',
    status: 200,
    ms: 14,
    ip: '203.0.113.7',
    detail: { target: 'user', summary: 'page 1' },
  },
  {
    ts: BASE_TS + 2_000,
    op: 'auth.revokeSession',
    mode: 'write',
    subject: 'admin',
    status: 200,
    ms: 9,
    ip: '203.0.113.7',
    detail: { target: 's_9' },
  },
  {
    ts: BASE_TS + 3_000,
    op: 'data.deleteRows',
    mode: 'write',
    subject: 'admin',
    status: 428,
    ms: 1,
    ip: null,
    detail: { summary: 'confirm required' },
  },
];

// ---- openapi ---------------------------------------------------------------

/**
 * A small but structurally faithful OpenAPI 3.1 document (`app.openapi` returns
 * `unknown` on the wire, so this is a plain object the API panel narrows).
 */
export const openapiDoc = {
  openapi: '3.1.0',
  info: { title: 'Example API', version: '1.0.0' },
  paths: {
    '/users': {
      get: {
        operationId: 'listUsers',
        summary: 'List users',
        tags: ['users'],
        parameters: [
          { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            description: 'A page of users',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/UserPage' } },
            },
          },
        },
      },
      post: {
        operationId: 'createUser',
        summary: 'Create a user',
        tags: ['users'],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/NewUser' } },
          },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/users/{id}': {
      get: {
        operationId: 'getUser',
        summary: 'Get a user',
        tags: ['users'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'A user' }, '404': { description: 'Not found' } },
      },
    },
    '/health': {
      get: {
        operationId: 'health',
        summary: 'Health probe',
        tags: ['system'],
        responses: { '200': { description: 'OK' } },
      },
    },
  },
  components: {
    schemas: {
      NewUser: {
        type: 'object',
        required: ['email'],
        properties: { email: { type: 'string' }, name: { type: 'string' } },
      },
      UserPage: {
        type: 'object',
        properties: { rows: { type: 'array', items: { $ref: '#/components/schemas/NewUser' } } },
      },
    },
  },
} as const;

// ---- responders ------------------------------------------------------------

/** Read + gated-write responders for every non-data domain panel. */
export function panelResponders(): FakeTransportTable {
  return {
    'app.openapi': openapiDoc,
    'api.tryit': (args) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { echo: { method: args.method, path: args.path, query: args.query ?? {} } },
    }),
    'auth.users': (args) => {
      const q = args.q?.toLowerCase();
      const rows =
        q === undefined || q === ''
          ? authUsers
          : authUsers.filter(
              (u) => u.email.toLowerCase().includes(q) || (u.name ?? '').toLowerCase().includes(q),
            );
      return { rows };
    },
    'auth.userDetail': (args) => authUserDetail(args.id),
    'auth.sessions': (args) =>
      args.userId === undefined
        ? authSessions
        : authSessions.filter((s) => s.userId === args.userId),
    'auth.organizations': authOrganizations,
    'auth.revokeSession': { ok: true },
    'queue.list': queues,
    'queue.depths': queueDepths,
    'queue.dlq': (args) => dlqByQueue[args.queue] ?? [],
    'schedule.jobs': scheduleJobs,
    'schedule.triggers': scheduleTriggers,
    'flags.list': flags,
    'flags.evaluate': (args) => evaluateFlag(args.key),
    'logs.tail': (args) =>
      args.level === undefined ? logs : logs.filter((l) => l.level === args.level),
    'live.subscriptions': liveSubscriptions,
    'presence.rooms': presenceRooms,
    'audit.tail': auditEntries,
  };
}
