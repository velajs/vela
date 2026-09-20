/**
 * The RPC dispatch envelope. `POST {prefix}/rpc/:op` carries an
 * {@link AdminRpcRequest} and returns a discriminated {@link AdminRpcResponse}.
 * The error branch carries an {@link AdminErrorBody} (enriched from the
 * `@velajs/errors` `WireErrorObject` server-side).
 */
import type { AdminErrorBody } from './errors';

/** A dispatch request. `args` shape is the op's `req` type from the op catalog. */
export interface AdminRpcRequest<A = unknown> {
  args?: A;
}

/** Success metadata attached to every ok response. */
export interface AdminResponseMeta {
  /** Server-measured handling time in milliseconds. */
  ms: number;
  op: string;
  mode: 'read' | 'write';
}

/**
 * The dispatch response, discriminated on `ok`. Narrowing on `ok === true`
 * exposes `data` + `meta`; `ok === false` exposes `error` + `status`.
 */
export type AdminRpcResponse<R = unknown> =
  | { ok: true; op: string; data: R; meta: AdminResponseMeta }
  | { ok: false; op: string; error: AdminErrorBody; status: number };
