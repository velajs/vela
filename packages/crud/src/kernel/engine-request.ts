import type { CrudTransactionScope } from './transaction';
/**
 * The engine's transport-neutral request/result shapes. The Vela integration
 * layer builds an `EngineRequest` from the Hono context (validated DTO body,
 * path id, raw query, context vars) and turns an `EngineResult` into the HTTP
 * response — the kernel itself never touches Hono, which keeps every verb
 * executor unit-testable without a server.
 */

/** Per-request identity/context vars sourced from the transport. */
export interface EngineRequestVars {
  user?: unknown;
  tenantId?: string;
  organizationId?: string;
  userId?: string;
  agentId?: string;
  agentRunId?: string;
}

export interface EngineRequest {
  /** Explicit same-database callback scope; never inferred from ambient state. */
  transaction?: CrudTransactionScope;
  /** Raw query params (list parsing, withDeleted, include, ...). */
  query?: Record<string, string | string[]>;
  /** Request body. Validated again by the engine against the derived schema. */
  body?: unknown;
  /** Path id param for point verbs. */
  id?: string | Readonly<Record<string, string | number>>;
  /** A verified tenant capability supplied by an admitted event/request scope. */
  tenant?: { requireTenantId(): string };
  /** Additional path params (`:version` on the version verbs). */
  params?: Record<string, string>;
  /** The underlying Web Request, when available (policies/hooks receive it). */
  request?: Request;
  vars?: EngineRequestVars;
}

export interface EngineResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}
