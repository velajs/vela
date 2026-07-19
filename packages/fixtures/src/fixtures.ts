/**
 * Realistic canned data for Studio tests, typed entirely by
 * `@velajs/studio-protocol`. Because every value is annotated with a protocol
 * type, this module is a compile-time drift guard: it stops building if the wire
 * contract changes shape.
 */
import type {
  AuthOrgRow,
  AuthSessionRow,
  AuthUserRow,
  EntrypointRow,
  FlagRow,
  ModuleNode,
  RouteRow,
  ScheduleJobRow,
  StudioCapabilities,
  StudioFeatureKey,
  StudioWriteGates,
} from '@velajs/studio-protocol';
import { STUDIO_FEATURE_KEYS } from '@velajs/studio-protocol';
import type { FakeTransportTable } from './fake-transport';

const featureMap = (value: boolean): Record<StudioFeatureKey, boolean> =>
  // fromEntries widens to string keys; the derived record type is exact.
  Object.fromEntries(STUDIO_FEATURE_KEYS.map((key) => [key, value])) as Record<
    StudioFeatureKey,
    boolean
  >;

const writeGates = (value: boolean): StudioWriteGates => ({
  dataEditable: value,
  schemaEditable: value,
  opsEditable: value,
  runAsIdentity: value,
  timeTravelRestore: value,
  transferImport: value,
});

/** Every feature live, every write gate open, full time-travel power. */
export const capabilitiesAllOn: StudioCapabilities = {
  features: featureMap(true),
  writes: writeGates(true),
  timeTravel: {
    markByTime: true,
    list: true,
    undo: true,
    inPlace: true,
    restartRequired: false,
    portableExport: true,
    createOnDemand: true,
    granularity: 'snapshot+cdc',
    scopeNote: 'Portable snapshot + CDC replay across all managed tables.',
  },
};

/**
 * A degraded deployment: the data browser is off, time travel is unbound
 * (`timeTravel: null`, `features.timeTravel: false`), and every write gate is
 * closed. Everything else stays lit so hide-on-disabled has visible + hidden
 * tabs to assert against.
 */
export const capabilitiesDegraded: StudioCapabilities = {
  features: { ...featureMap(true), data: false, timeTravel: false },
  writes: writeGates(false),
  timeTravel: null,
};

/** A small app route table (`app.routes`). */
export const routes: RouteRow[] = [
  { method: 'GET', path: '/health', handler: 'HealthController#check', source: 'controller' },
  { method: 'GET', path: '/users', handler: 'UsersController#list', source: 'controller' },
  { method: 'POST', path: '/users', handler: 'UsersController#create', source: 'controller' },
  { method: 'GET', path: '/_vela/admin/health', handler: '(mounted)', source: 'mounted' },
];

/** A small module graph (`app.modules`). */
export const modules: ModuleNode[] = [
  {
    moduleId: 'AppModule',
    imports: ['UsersModule', 'AuthModule'],
    isGlobal: false,
    lazy: false,
    providers: ['AppService'],
    exports: [],
  },
  {
    moduleId: 'UsersModule',
    imports: [],
    isGlobal: false,
    lazy: false,
    providers: ['UsersService', 'UsersController'],
    exports: ['UsersService'],
  },
  {
    moduleId: 'AuthModule',
    imports: [],
    isGlobal: true,
    lazy: true,
    providers: ['AuthService'],
    exports: ['AuthService'],
  },
];

/** A small entrypoint set (`app.entrypoints`). */
export const entrypoints: EntrypointRow[] = [
  { kind: 'queue', target: 'EmailQueue#process', meta: { batch: 10 } },
  { kind: 'cron', target: 'ReportJob#run', meta: { cron: '0 * * * *' } },
  { kind: 'http', target: 'UsersController#list' },
];

/** Feature flags (`flags.list`) — proves `FlagRow.value: FlagValue`, not `enabled`. */
export const flags: FlagRow[] = [
  { key: 'new-dashboard', value: true },
  { key: 'max-upload-mb', value: 25 },
  { key: 'theme', value: 'dark' },
  { key: 'rollout', value: { percent: 50 } },
];

/** Scheduled jobs (`schedule.jobs`) — exercises the cron/interval kind union. */
export const scheduleJobs: ScheduleJobRow[] = [
  {
    name: 'ReportJob.run',
    kind: 'cron',
    expression: '0 * * * *',
    lastRun: 1_700_000_000_000,
    nextRun: 1_700_003_600_000,
  },
  { name: 'HeartbeatJob.ping', kind: 'interval', ms: 30_000 },
];

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
];

/** Auth sessions (`auth.sessions`). */
export const authSessions: AuthSessionRow[] = [
  {
    id: 's_1',
    userId: 'u_ada',
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_600_000_000,
    ipAddress: '203.0.113.7',
    userAgent: 'Mozilla/5.0',
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
];

/**
 * The default canned table wiring capabilities + the read ops most tests need.
 * Spread `overrides` last to swap individual responders.
 */
export function fakeTable(overrides: FakeTransportTable = {}): FakeTransportTable {
  return {
    'studio.capabilities': capabilitiesAllOn,
    'app.routes': routes,
    'app.modules': modules,
    'app.entrypoints': entrypoints,
    'flags.list': flags,
    'schedule.jobs': scheduleJobs,
    'auth.users': { rows: authUsers },
    'auth.sessions': authSessions,
    'auth.organizations': authOrganizations,
    'auth.revokeSession': { ok: true },
    ...overrides,
  };
}
