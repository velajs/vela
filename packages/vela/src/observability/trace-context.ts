import type { TraceContext } from './types';

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const ZERO_ID = /^0+$/;
const STATE_KEY =
  /^(?:[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13})$/;

/** Invalid vendor state is discarded without discarding a valid parent. */
function traceState(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return undefined;
  const members = value.split(',');
  if (members.length > 32) return undefined;
  const keys = new Set<string>();
  const normalized: string[] = [];
  for (const member of members) {
    const entry = member.replace(/^[ \t]+|[ \t]+$/g, '');
    const equals = entry.indexOf('=');
    const key = entry.slice(0, equals);
    const data = entry.slice(equals + 1);
    if (
      equals < 1 ||
      !STATE_KEY.test(key) ||
      keys.has(key) ||
      data.length === 0 ||
      data.length > 256 ||
      !/^[\x20-\x2b\x2d-\x3c\x3e-\x7e]*[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/.test(data)
    )
      return undefined;
    keys.add(key);
    normalized.push(`${key}=${data}`);
  }
  return normalized.join(',');
}

/** Validate and copy even explicitly supplied contexts before propagation. */
export function validateTraceContext(value: unknown): TraceContext | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    if (!('traceId' in value) || !('spanId' in value) || !('traceFlags' in value)) return undefined;
    const { traceId, spanId, traceFlags } = value;
    if (
      typeof traceId !== 'string' ||
      !TRACE_ID.test(traceId) ||
      ZERO_ID.test(traceId) ||
      typeof spanId !== 'string' ||
      !SPAN_ID.test(spanId) ||
      ZERO_ID.test(spanId) ||
      typeof traceFlags !== 'number' ||
      !Number.isInteger(traceFlags) ||
      traceFlags < 0 ||
      traceFlags > 255
    )
      return undefined;
    const state = traceState('traceState' in value ? value.traceState : undefined);
    return Object.freeze({
      traceId,
      spanId,
      traceFlags: traceFlags & 1,
      ...('isRemote' in value && value.isRemote === true ? { isRemote: true } : {}),
      ...(state ? { traceState: state } : {}),
    });
  } catch {
    return undefined;
  }
}

/** Extract bounded W3C trace headers. This does not establish trust or read baggage. */
export function extractTraceContext(headers: Headers): TraceContext | undefined {
  const parent = headers.get('traceparent');
  if (!parent || parent.length > 512) return undefined;
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.+)?$/.exec(parent);
  if (!match || match[1] === 'ff' || (match[1] === '00' && match[5])) return undefined;
  return validateTraceContext({
    traceId: match[2],
    spanId: match[3],
    traceFlags: Number.parseInt(match[4]!, 16),
    traceState: headers.get('tracestate'),
    isRemote: true,
  });
}

/**
 * Replace only W3C trace headers on caller-owned mutable Headers. An absent or
 * invalid context clears stale trace headers; no baggage or credentials are copied.
 */
export function injectTraceContext(headers: Headers, context: TraceContext | undefined): void {
  const valid = validateTraceContext(context);
  headers.delete('traceparent');
  headers.delete('tracestate');
  if (!valid) return;
  headers.set(
    'traceparent',
    `00-${valid.traceId}-${valid.spanId}-${valid.traceFlags === 1 ? '01' : '00'}`,
  );
  if (valid.traceState) headers.set('tracestate', valid.traceState);
}
