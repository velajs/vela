import type { Context } from 'hono';

/**
 * The typed action a request wants to perform. The authorizer receives this
 * and can deny, allow, or allow-with-overrides (rewriting the effective key /
 * prefix / limits) — the load-bearing IDOR / cross-tenant guard.
 */
export type StorageAction =
  | { type: 'sign-upload'; key: string; contentType?: string; size?: number }
  | { type: 'multipart-create'; key: string; contentType?: string }
  | { type: 'multipart-sign-part'; key: string; uploadId: string; partNumber: number }
  | { type: 'multipart-complete'; key: string; uploadId: string }
  | { type: 'multipart-abort'; key: string; uploadId: string }
  | { type: 'download'; key: string }
  | { type: 'head'; key: string }
  | { type: 'list'; prefix?: string }
  | { type: 'delete'; keys: string[] };

export interface StorageAuthContext {
  /** The raw Web `Request` (edge-safe). */
  req: Request;
  /** The Hono context — `c.env` (bindings/secrets), `c.get('user')` from an upstream guard. */
  ctx: Context;
  /** The bucket name this controller is bound to. */
  driver: string;
}

/** Return this to ALLOW with server-side modifications. */
export interface StorageAuthResult {
  key?: string;
  keys?: string[];
  prefix?: string;
  maxSize?: number;
  expiresIn?: number;
  metadata?: Record<string, string>;
}

export type StorageAuthorizer = (
  action: StorageAction,
  context: StorageAuthContext,
) => boolean | StorageAuthResult | Promise<boolean | StorageAuthResult>;
