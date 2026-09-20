/** Per-route request-body policy for streaming/upload endpoints. */
export interface VelaBodyLimitOverride {
  /** Exact path, `*`, or a trailing-wildcard prefix such as `/uploads/*`. */
  path: string;
  /** Wire methods this override applies to. Omit for every method. */
  methods?: string[];
  /** Positive byte ceiling, or `false` when a trusted outer layer enforces it. */
  maxBytes: number | false;
}

export interface VelaBodySecurityOptions {
  /** Global body ceiling. Defaults to 1 MiB. */
  maxBytes?: number | false;
  /** Narrow, route-specific limits for streaming/upload endpoints. */
  streamingOverrides?: VelaBodyLimitOverride[];
}

export interface VelaQuerySecurityOptions {
  /** Maximum number of query-string entries (duplicates count). Defaults to 100. */
  maxParameters?: number | false;
  /** Maximum bracket/dot nesting depth in a query key. Defaults to 5. */
  maxDepth?: number | false;
  /** Maximum raw query-string bytes. Defaults to 8 KiB. */
  maxBytes?: number | false;
}

/** Edge-safe HTTP parsing limits applied before user middleware and handlers. */
export interface VelaSecurityOptions {
  body?: VelaBodySecurityOptions;
  query?: VelaQuerySecurityOptions;
}

export const DEFAULT_QUERY_PARAMETER_LIMIT = 100;
export const DEFAULT_QUERY_DEPTH_LIMIT = 5;
export const DEFAULT_QUERY_BYTES_LIMIT = 8 * 1024;

/**
 * Security relaxations are most important on edge runtimes, where `process`
 * does not exist. Node follows `NODE_ENV=production`; an unknown/non-Node
 * runtime is treated as production rather than silently suppressing warnings.
 */
export function shouldWarnProductionSecurity(): boolean {
  const processLike = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
  return processLike === undefined || processLike.env?.NODE_ENV === 'production';
}

export function warnRelaxedSecurityLimit(
  name: string,
  value: number | false,
  secureDefault: number,
): void {
  if (!shouldWarnProductionSecurity() || (value !== false && value <= secureDefault)) return;
  const configured = value === false ? 'disabled' : `raised to ${value}`;
  console.warn(
    `[vela] security warning: ${name} is ${configured} (secure default ${secureDefault}); ` +
      'ensure an authenticated outer layer enforces an equivalent bound',
  );
}

export function validatePositiveLimit(name: string, value: number | false): void {
  if (value !== false && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`${name} must be a positive safe integer, or false`);
  }
}

export function queryKeyDepth(key: string): number {
  let depth = 0;
  for (const character of key) {
    if (character === '[' || character === '.') depth++;
  }
  return depth;
}
