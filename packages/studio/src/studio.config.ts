/**
 * Studio's environment slice: the `VELA_STUDIO_*` variables and secrets read
 * from the application's ENV, when a runtime seeded one. Module options
 * override these env values; the merge into {@link ResolvedStudioConfig}
 * lives in the module (env under options).
 */
import { ENV, Inject, Injectable, type DynamicModule, type Type, type VelaEnv } from '@velajs/vela';
import type { Container } from '@velajs/vela/module-kit';
import { STUDIO_DEFAULT_PATH } from '@velajs/studio-protocol';
import type { EditableFlags, ResolvedStudioConfig, StudioModuleOptions } from './studio.types';
import { STUDIO_APPLICATION_CONTAINER } from './tokens';

/** The `VELA_STUDIO_*` variables and secrets Studio reads from ENV. */
export interface StudioEnv {
  VELA_STUDIO_TOKEN?: string;
  VELA_STUDIO_DATA_EDITABLE?: string;
  VELA_STUDIO_SCHEMA_EDITABLE?: string;
  VELA_STUDIO_OPS_EDITABLE?: string;
  VELA_STUDIO_TIMETRAVEL_EDITABLE?: string;
  VELA_STUDIO_TRANSFER_EDITABLE?: string;
}

/** The env-derived config slice (before module-option overrides). */
export interface StudioEnvConfig {
  token?: string;
  data?: boolean;
  schema?: boolean;
  ops?: boolean;
  timeTravel?: boolean;
  transfer?: boolean;
}

/** One string variable or secret; any other value is ignored. */
function envString(env: VelaEnv | undefined, key: keyof StudioEnv): string | undefined {
  if (typeof env !== 'object' || env === null) return undefined;
  const value: unknown = Reflect.get(env, key);
  return typeof value === 'string' ? value : undefined;
}

/** Parse a boolean-ish env flag: `'1'` / `'true'` (case-insensitive) → true. */
function envBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false' || v === '') return false;
  return undefined;
}

/**
 * Validate the `VELA_STUDIO_*` values of an environment. Non-string values
 * are ignored, so a stray binding can never enable Studio or a write gate.
 */
export function readStudioEnv(env: VelaEnv | undefined): StudioEnvConfig {
  return {
    token: envString(env, 'VELA_STUDIO_TOKEN'),
    data: envBool(envString(env, 'VELA_STUDIO_DATA_EDITABLE')),
    schema: envBool(envString(env, 'VELA_STUDIO_SCHEMA_EDITABLE')),
    ops: envBool(envString(env, 'VELA_STUDIO_OPS_EDITABLE')),
    timeTravel: envBool(envString(env, 'VELA_STUDIO_TIMETRAVEL_EDITABLE')),
    transfer: envBool(envString(env, 'VELA_STUDIO_TRANSFER_EDITABLE')),
  };
}

/**
 * The application's environment: the one a runtime seeds (`VelaFactory`'s
 * `env`, a runtime adapter), which registers outside every module, else the
 * one a `@Global()` module exports to every module. An application-wide lookup
 * that finds neither falls back to any module registering `ENV`, even for
 * itself or only for its importers; that is no application's environment, so
 * there is none.
 */
function applicationEnv(application: Container): VelaEnv | undefined {
  const seeded = application
    .getOwnerModuleIds(ENV)
    .some((moduleId) => application.getModuleScope(moduleId) === undefined);
  const shared = application
    .getModuleDescriptions()
    .some(
      ({ moduleId, global }) =>
        global && application.getModuleScope(moduleId)?.exportedTokens.has(ENV) === true,
    );
  return seeded || shared ? application.resolve(ENV) : undefined;
}

/**
 * The env slice of one application: its seeded `ENV`, or the one a `@Global()`
 * module gives every module, as `app.get(ENV)` returns it. Never one a plugin
 * import makes visible in StudioModule's scope, or one a module keeps to itself
 * or its importers: without an application environment Studio keeps its
 * option-only, default-closed configuration.
 */
@Injectable()
export class StudioEnvReader {
  readonly config: StudioEnvConfig;

  constructor(@Inject(STUDIO_APPLICATION_CONTAINER) application: Container) {
    this.config = readStudioEnv(applicationEnv(application));
  }
}

const DEFAULT_RATE_LIMIT = { windowMs: 60_000, max: 120 } as const;

// The data browser's settings, which its panel now takes.
const PANEL_OPTIONS = ['managedModels', 'runAsIdentity'] as const;

/**
 * Refuse options StudioModule no longer takes, whether an async factory
 * returned them or JavaScript passed them: ignoring them would silently open
 * every model to the data browser and run its writes as the master principal.
 */
function assertStudioModuleOptions(options: StudioModuleOptions): void {
  for (const key of PANEL_OPTIONS) {
    if (typeof options === 'object' && options !== null && key in options) {
      throw new TypeError(
        `StudioModule no longer takes ${key}: pass it to the data browser's panel, ` +
          'crudPanel({ managedModels, runAsIdentity }) from @velajs/studio/crud.',
      );
    }
  }
}

/**
 * Merge env-derived config UNDER module options into the resolved shape.
 * `applicationRoot` (the application's `ROOT_MODULE`) is documented when the
 * options name no `rootModule`.
 */
export function resolveStudioConfig(
  env: StudioEnvConfig,
  options: StudioModuleOptions,
  applicationRoot?: Type | DynamicModule,
): ResolvedStudioConfig {
  assertStudioModuleOptions(options);
  const rootModule = options.rootModule ?? applicationRoot;
  const token = options.token ?? env.token;
  const editable: EditableFlags = {
    data: options.editable?.data ?? env.data ?? false,
    schema: options.editable?.schema ?? env.schema ?? false,
    identity: options.editable?.identity ?? false,
    ops: options.editable?.ops ?? env.ops ?? false,
    timeTravel: options.editable?.timeTravel ?? env.timeTravel ?? false,
    transfer: options.editable?.transfer ?? env.transfer ?? false,
  };
  // Default-closed: enabled iff a token exists, unless explicitly disabled.
  const enabled = options.enabled === false ? false : Boolean(token);
  return {
    enabled,
    path: options.path ?? STUDIO_DEFAULT_PATH,
    absolute: options.absolute ?? false,
    ...(token !== undefined ? { token } : {}),
    ...(rootModule !== undefined ? { rootModule } : {}),
    editable,
    rateLimit: options.rateLimit === undefined ? { ...DEFAULT_RATE_LIMIT } : options.rateLimit,
    subTokenTtlSec: options.subTokenTtlSec ?? 300,
    auditBufferSize: options.auditBufferSize ?? 500,
    logBufferSize: options.logBufferSize ?? 1000,
  };
}
