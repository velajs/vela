import { STUDIO_OPS } from '@velajs/studio-protocol';
/**
 * Realistic canned data for Studio tests, typed entirely by
 * `@velajs/studio-protocol`. Because every value is annotated with a protocol
 * type, this module is a compile-time drift guard: it stops building if the wire
 * contract changes shape.
 *
 * The application-introspection rows + capability snapshots live here; the
 * package-backed panel rows live in `./panel-fixtures`, and the data-browser
 * dataset + query engine in `./data-fixtures`. `fakeTable` composes all three.
 */
import type {
  EntrypointRow,
  ModuleNode,
  RouteRow,
  StudioCapabilities,
  StudioFeatureKey,
  StudioWriteGates,
} from '@velajs/studio-protocol';
import { STUDIO_FEATURE_KEYS } from '@velajs/studio-protocol';
import type { FakeTransportTable } from './fake-transport';
import { dataResponders } from './data-fixtures';
import { panelResponders } from './panel-fixtures';
import { timeTravelCapabilitiesPortable, timeTravelResponders } from './time-travel-fixtures';

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
  operations: [...STUDIO_OPS],
  features: featureMap(true),
  writes: writeGates(true),
  timeTravel: timeTravelCapabilitiesPortable,
};

/**
 * A degraded deployment: the data browser is off, time travel is unbound
 * (`timeTravel: null`, `features.timeTravel: false`), and every write gate is
 * closed. Everything else stays lit so hide-on-disabled has visible + hidden
 * tabs to assert against.
 */
export const capabilitiesDegraded: StudioCapabilities = {
  operations: [...STUDIO_OPS],
  features: { ...featureMap(true), data: false, timeTravel: false },
  writes: writeGates(false),
  timeTravel: null,
};

/**
 * Every feature live but every write gate closed — a read-only Studio. Drives
 * the "write affordance hidden when `opsEditable`/`dataEditable` is false" tests
 * (try-it execute, session revoke, queue send/replay, schedule run-now).
 */
export const capabilitiesReadOnly: StudioCapabilities = {
  operations: [...STUDIO_OPS],
  features: featureMap(true),
  writes: writeGates(false),
  timeTravel: capabilitiesAllOn.timeTravel,
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

/**
 * The default canned table wiring capabilities + every read op the panels need
 * (app introspection here, data-browser + package panels composed in). Spread
 * `overrides` last to swap individual responders.
 */
export function fakeTable(overrides: FakeTransportTable = {}): FakeTransportTable {
  return {
    'studio.capabilities': capabilitiesAllOn,
    'app.routes': routes,
    'app.modules': modules,
    'app.entrypoints': entrypoints,
    ...dataResponders(),
    ...panelResponders(),
    ...timeTravelResponders(),
    ...overrides,
  };
}
