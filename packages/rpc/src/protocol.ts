/** Vela RPC v1 is JSON over HTTP, not the Cloudflare native RPC protocol. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export const RPC_VERSION = 1;
const NAME = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/;

export function isProcedureName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 160 && NAME.test(value);
}

export class RpcProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcProtocolError';
  }
}

/** Reject values JSON would silently alter, omit, or serialize through user hooks. */
export function assertJson(value: unknown): asserts value is JsonValue {
  const ancestors = new Set<object>();
  let nodes = 0;
  function visit(item: unknown, depth: number): void {
    if (++nodes > 100_000 || depth > 64)
      throw new RpcProtocolError('JSON structure exceeds limits');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || item === null)
      throw new RpcProtocolError('Expected a JSON value');
    if (ancestors.has(item)) throw new RpcProtocolError('Cyclic JSON value');
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (
        Object.getPrototypeOf(item) !== Array.prototype ||
        Reflect.ownKeys(item).length !== item.length + 1 ||
        Object.keys(item).length !== item.length
      )
        throw new RpcProtocolError('Expected a dense JSON array');
      for (let i = 0; i < item.length; i++) {
        const d = Object.getOwnPropertyDescriptor(item, String(i));
        if (!d || !('value' in d)) throw new RpcProtocolError('JSON accessors are not supported');
        visit(d.value, depth + 1);
      }
    } else {
      const proto: unknown = Object.getPrototypeOf(item);
      if (proto !== Object.prototype && proto !== null)
        throw new RpcProtocolError('Expected a plain JSON object');
      for (const key of Reflect.ownKeys(item)) {
        if (typeof key !== 'string')
          throw new RpcProtocolError('JSON symbol keys are not supported');
        const d = Object.getOwnPropertyDescriptor(item, key);
        if (!d || !('value' in d) || !d.enumerable)
          throw new RpcProtocolError('Expected an enumerable JSON data property');
        visit(d.value, depth + 1);
      }
    }
    ancestors.delete(item);
  }
  visit(value, 0);
}

export interface RpcRequest {
  version: 1;
  id: string;
  procedure: string;
  input: JsonValue;
}
export interface RpcFailure {
  version: 1;
  id: string;
  procedure: string;
  ok: false;
  error: { code: string; message: string; status: number };
}
export interface RpcSuccess {
  version: 1;
  id: string;
  procedure: string;
  ok: true;
  result: JsonValue;
}
export type RpcResponse = RpcSuccess | RpcFailure;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RpcProtocolError('Expected an RPC object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  const names = Object.keys(value);
  if (names.length !== expected.length || names.some((key) => !expected.includes(key)))
    throw new RpcProtocolError('Unexpected RPC envelope fields');
}
function identity(value: Record<string, unknown>): { version: 1; id: string; procedure: string } {
  if (
    value.version !== RPC_VERSION ||
    typeof value.id !== 'string' ||
    !/^[\x21-\x7e]{1,128}$/.test(value.id) ||
    !isProcedureName(value.procedure)
  ) {
    throw new RpcProtocolError('Invalid RPC version, ID or procedure');
  }
  return { version: RPC_VERSION, id: value.id, procedure: value.procedure };
}
export function parseRpcRequest(value: unknown): RpcRequest {
  assertJson(value);
  const r = record(value);
  keys(r, ['version', 'id', 'procedure', 'input']);
  const head = identity(r);
  assertJson(r.input);
  return { ...head, input: r.input };
}
export function parseRpcResponse(
  value: unknown,
  request: Pick<RpcRequest, 'id' | 'procedure'>,
): RpcResponse {
  assertJson(value);
  const r = record(value);
  const head = identity(r);
  if (head.id !== request.id || head.procedure !== request.procedure)
    throw new RpcProtocolError('RPC response correlation mismatch');
  if (r.ok === true) {
    keys(r, ['version', 'id', 'procedure', 'ok', 'result']);
    assertJson(r.result);
    return { ...head, ok: true, result: r.result };
  }
  if (r.ok !== false) throw new RpcProtocolError('Invalid RPC outcome');
  keys(r, ['version', 'id', 'procedure', 'ok', 'error']);
  const error = record(r.error);
  keys(error, ['code', 'message', 'status']);
  if (
    typeof error.code !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,160}$/.test(error.code) ||
    typeof error.message !== 'string' ||
    error.message.length > 2048 ||
    typeof error.status !== 'number' ||
    !Number.isInteger(error.status) ||
    error.status < 400 ||
    error.status > 599
  )
    throw new RpcProtocolError('Invalid RPC error');
  return {
    ...head,
    ok: false,
    error: { code: error.code, message: error.message, status: error.status },
  };
}
