import { stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { parse, type ParseError } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { hasErrorCode, isRecord, readInput } from './files.js';

/** The files Wrangler and the Cloudflare Vite plugin read, in their order of precedence. */
export const WRANGLER_FILES = ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml'] as const;

/** A parsed Wrangler configuration file. */
export interface WranglerConfig {
  readonly path: string;
  readonly text: string;
  readonly format: 'json' | 'jsonc' | 'toml';
  /** The top-level configuration object. */
  readonly root: Record<string, unknown>;
}

/** Decode only data; parser errors deliberately omit configuration values. */
export function parseWranglerText(source: string, path: string): unknown {
  const extension = extname(path).toLowerCase();
  if (extension === '.toml') {
    try {
      return parseToml(source);
    } catch {
      throw new Error('Invalid Wrangler TOML configuration.');
    }
  }
  if (extension !== '.json' && extension !== '.jsonc') {
    throw new Error('Wrangler configuration must be a .json, .jsonc or .toml file.');
  }
  const errors: ParseError[] = [];
  const result: unknown = parse(source, errors, {
    allowTrailingComma: extension === '.jsonc',
    disallowComments: extension === '.json',
  });
  if (errors.length > 0) throw new Error('Invalid Wrangler JSON configuration.');
  return result;
}

/** The first Wrangler file in `cwd`, without searching parent directories. */
export async function findWranglerConfig(cwd: string): Promise<{
  readonly path: string | undefined;
  readonly candidates: readonly string[];
}> {
  const candidates: string[] = [];
  for (const name of WRANGLER_FILES) {
    const candidate = join(resolve(cwd), name);
    candidates.push(candidate);
    try {
      // eslint-disable-next-line no-await-in-loop -- Precedence: stop at the first file.
      if ((await stat(candidate)).isFile()) return { path: candidate, candidates };
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    }
  }
  return { path: undefined, candidates };
}

export async function readWranglerConfig(path: string): Promise<WranglerConfig> {
  const absolute = resolve(path);
  const text = await readInput(absolute);
  const raw = parseWranglerText(text, absolute);
  if (!isRecord(raw)) throw new Error('Wrangler configuration must be an object.');
  const extension = extname(absolute).toLowerCase().slice(1);
  const format = extension === 'toml' ? 'toml' : extension === 'json' ? 'json' : 'jsonc';
  return { path: absolute, text, format, root: raw };
}

const ENVIRONMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

/** The section of a named environment, or the top level when `environment` is omitted. */
export function environmentSection(
  config: WranglerConfig,
  environment: string | undefined,
): Record<string, unknown> {
  if (environment === undefined) return config.root;
  if (!ENVIRONMENT_NAME.test(environment)) {
    throw new Error(
      'An environment name uses letters, digits, underscores or dashes, starting with a letter or digit.',
    );
  }
  const environments = config.root.env;
  const selected =
    isRecord(environments) && Object.hasOwn(environments, environment)
      ? environments[environment]
      : undefined;
  if (!isRecord(selected)) {
    throw new Error(
      `The environment ${JSON.stringify(environment)} is not declared in ${config.path}.`,
    );
  }
  return selected;
}

/** The Worker entry of the selected environment (a named one inherits the top-level `main`). */
export function wranglerMain(config: WranglerConfig, environment?: string): string {
  const section = environmentSection(config, environment);
  const main = Object.hasOwn(section, 'main') ? section.main : config.root.main;
  if (typeof main !== 'string' || main.trim() === '') {
    throw new Error(`${config.path} declares no "main" Worker entry.`);
  }
  return resolve(dirname(config.path), main);
}

/**
 * The plain variables of the selected environment: what a Worker's ENV holds
 * before any binding or secret. Named environments do not inherit `vars`.
 */
export function wranglerVars(
  config: WranglerConfig,
  environment?: string,
): Record<string, unknown> {
  const vars = environmentSection(config, environment).vars;
  if (vars === undefined) return {};
  if (!isRecord(vars)) throw new Error(`Invalid Wrangler field: vars in ${config.path}.`);
  return { ...vars };
}

/** The Worker name of the selected environment, as Wrangler derives it. */
export function wranglerWorkerName(config: WranglerConfig, environment?: string): string {
  const section = environmentSection(config, environment);
  const name = Object.hasOwn(section, 'name') ? section.name : config.root.name;
  if (typeof name !== 'string' || name === '') {
    throw new Error(`${config.path} declares no Worker "name".`);
  }
  return environment === undefined || Object.hasOwn(section, 'name')
    ? name
    : `${name}-${environment}`;
}
