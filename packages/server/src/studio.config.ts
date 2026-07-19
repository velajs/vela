/**
 * `studioConfig` — the `registerAs('studio', …)` namespace that reads the
 * `VELA_STUDIO_*` environment. Module options override these env values; the
 * merge into {@link ResolvedStudioConfig} lives in the module (env under
 * options).
 */
import { registerAs } from '@velajs/vela';
import { STUDIO_DEFAULT_PATH } from '@velajs/studio-protocol';
import type { EditableFlags, ResolvedStudioConfig, StudioModuleOptions } from './studio.types';

/** The `VELA_STUDIO_*` env vars this namespace consumes. */
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

/** Parse a boolean-ish env flag: `'1'` / `'true'` (case-insensitive) → true. */
function envBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false' || v === '') return false;
  return undefined;
}

export const studioConfig = registerAs(
  'studio',
  (env: StudioEnv): StudioEnvConfig => ({
    token: env.VELA_STUDIO_TOKEN,
    data: envBool(env.VELA_STUDIO_DATA_EDITABLE),
    schema: envBool(env.VELA_STUDIO_SCHEMA_EDITABLE),
    ops: envBool(env.VELA_STUDIO_OPS_EDITABLE),
    timeTravel: envBool(env.VELA_STUDIO_TIMETRAVEL_EDITABLE),
    transfer: envBool(env.VELA_STUDIO_TRANSFER_EDITABLE),
  }),
);

const DEFAULT_RATE_LIMIT = { windowMs: 60_000, max: 120 } as const;

/** Merge env-derived config UNDER module options into the resolved shape. */
export function resolveStudioConfig(
  env: StudioEnvConfig,
  options: StudioModuleOptions,
): ResolvedStudioConfig {
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
    editable,
    rateLimit: options.rateLimit === undefined ? { ...DEFAULT_RATE_LIMIT } : options.rateLimit,
    subTokenTtlSec: options.subTokenTtlSec ?? 300,
    auditBufferSize: options.auditBufferSize ?? 500,
    logBufferSize: options.logBufferSize ?? 1000,
  };
}
