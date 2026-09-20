/**
 * Normalise {@link StudioHostOptions} into the fully-defaulted shape the request
 * handler consumes, and the small path helpers that compose the SPA base path
 * with asset filenames.
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_ADMIN_PATH, DEFAULT_BASE_PATH, DEFAULT_HOST } from './constants';
import type { StudioHostOptions, WarnLogger } from './types';

/** A base path with a single leading slash and no trailing slash (root → `''`). */
export function normaliseBasePath(basePath: string): string {
  const trimmed = basePath.trim();
  if (trimmed === '' || trimmed === '/') {
    return '';
  }
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading;
}

/** An admin path with a single leading slash and no trailing slash. */
export function normaliseAdminPath(adminPath: string): string {
  const trimmed = adminPath.trim();
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeading.length > 1 && withLeading.endsWith('/')
    ? withLeading.slice(0, -1)
    : withLeading;
}

/** Join a normalised base path with an asset filename into a host-absolute URL. */
export function joinBase(normalisedBase: string, fileName: string): string {
  return `${normalisedBase}/${fileName}`;
}

/** The fully-resolved host configuration, defaults applied, per-server derived values fixed. */
export interface ResolvedOptions {
  readonly cwd: string;
  readonly host: string;
  readonly port: number;
  readonly workerOrigin: string;
  readonly adminToken?: string;
  /** Normalised admin proxy prefix (leading slash, no trailing slash). */
  readonly adminPath: string;
  /** Normalised SPA base path (leading slash, or `''` for root). */
  readonly basePath: string;
  /** Per-server browser session credential (never the master admin token). */
  readonly sessionToken: string;
  readonly resolveFrom: string;
  readonly fetchImpl?: typeof fetch;
  readonly logger?: WarnLogger;
}

/** Apply defaults + derive per-server values (the session token) once. */
export function resolveOptions(options: StudioHostOptions): ResolvedOptions {
  const origin = new URL(options.workerOrigin);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new Error(
      'workerOrigin must be an HTTP(S) origin without credentials, path, query, or fragment.',
    );
  }
  return {
    cwd: options.cwd ?? process.cwd(),
    host: options.host ?? DEFAULT_HOST,
    port: options.port ?? 0,
    workerOrigin: origin.origin,
    adminToken: options.adminToken,
    adminPath: normaliseAdminPath(options.adminPath ?? DEFAULT_ADMIN_PATH),
    basePath: normaliseBasePath(options.basePath ?? DEFAULT_BASE_PATH),
    sessionToken: randomUUID(),
    resolveFrom: options.resolveFrom ?? import.meta.url,
    fetchImpl: options.fetchImpl,
    logger: options.logger,
  };
}
