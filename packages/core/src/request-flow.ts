/**
 * HTTP ↔ engine seam: builds the transport-neutral `EngineRequest` from the
 * Hono context (validated DTO body, path params, raw query, context vars) and
 * renders an `EngineResult` as the HTTP response. The engine consumes the
 * `@Body`-resolved DTO — the request body is never re-read.
 */

import type { Context } from 'hono';
import type { EngineRequest, EngineResult } from './kernel/engine-request';

/** Context-var keys the engine forwards into hooks/policies. */
const VAR_KEYS = ['user', 'tenantId', 'organizationId', 'userId', 'agentId', 'agentRunId'] as const;

export function buildEngineRequest(
  c: Context,
  parts: { body?: unknown; id?: string } = {},
): EngineRequest {
  const vars: Record<string, unknown> = {};
  for (const key of VAR_KEYS) {
    const value = c.get(key as never);
    if (value !== undefined) vars[key] = value;
  }
  return {
    // `queries()` preserves repeated params (`?include=a&include=b`).
    query: c.req.queries(),
    body: parts.body,
    id: parts.id,
    request: c.req.raw,
    vars,
  };
}

export function toResponse(c: Context, result: EngineResult): Response {
  for (const [name, value] of Object.entries(result.headers ?? {})) {
    c.header(name, value);
  }
  // Non-JSON payloads (CSV export) set their own Content-Type and pass a
  // string body; everything else is the JSON envelope.
  if (typeof result.body === 'string' && result.headers?.['Content-Type'] !== undefined) {
    return c.body(result.body, result.status as never);
  }
  return c.json(result.body as never, result.status as never);
}
