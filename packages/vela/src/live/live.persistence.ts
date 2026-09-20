import { MAX_LIVE_FRAME_BYTES } from '@velajs/live-protocol';
import type { LiveIdentity, SubscriptionRecord } from './live.types';

type DataValue = undefined | null | boolean | number | string | DataValue[] | DataRecord;
interface DataRecord {
  [key: string]: DataValue;
}
type DataCopy = { ok: true; value: DataValue } | { ok: false };

const encoder = new TextEncoder();
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);

/** Read plain own data properties without invoking accessors. */
function ownData(value: unknown): Map<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const entries = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || unsafeKeys.has(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return undefined;
    const property: unknown = descriptor.value;
    entries.set(key, property);
  }
  return entries;
}

/** Identity claims are inert data, copied so attachment mutation cannot rewrite authorization. */
function copyData(
  value: unknown,
  seen: WeakSet<object>,
  budget: { nodes: number },
  depth = 0,
): DataCopy {
  budget.nodes += 1;
  if (budget.nodes > 10_000 || depth > 32) return { ok: false };
  if (
    value === undefined ||
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return { ok: true, value };
  }
  if (typeof value === 'number')
    return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  if (typeof value !== 'object' || seen.has(value)) return { ok: false };
  seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 10_000 - budget.nodes) {
      return { ok: false };
    }
    // Only dense arrays of data properties can be reproduced without invoking code.
    if (Reflect.ownKeys(value).length !== value.length + 1) return { ok: false };
    const copy: DataValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !('value' in descriptor)) return { ok: false };
      const child: unknown = descriptor.value;
      const parsed = copyData(child, seen, budget, depth + 1);
      if (!parsed.ok) return parsed;
      copy.push(parsed.value);
    }
    seen.delete(value);
    return { ok: true, value: copy };
  }

  const properties = ownData(value);
  if (!properties) return { ok: false };
  const copy: DataRecord = {};
  for (const [key, child] of properties) {
    const parsed = copyData(child, seen, budget, depth + 1);
    if (!parsed.ok) return parsed;
    copy[key] = parsed.value;
  }
  seen.delete(value);
  return { ok: true, value: copy };
}

function readIdentity(value: unknown): LiveIdentity | undefined {
  const parsed = copyData(value, new WeakSet(), { nodes: 0 });
  if (
    !parsed.ok ||
    typeof parsed.value !== 'object' ||
    parsed.value === null ||
    Array.isArray(parsed.value)
  ) {
    return undefined;
  }
  if (encoder.encode(JSON.stringify(parsed.value)).byteLength > MAX_LIVE_FRAME_BYTES)
    return undefined;
  const { expiresAtMs, ...claims } = parsed.value;
  if (expiresAtMs === undefined) return claims;
  if (typeof expiresAtMs !== 'number' || !Number.isSafeInteger(expiresAtMs) || expiresAtMs < 0) {
    return undefined;
  }
  // Retain elapsed expiry: the live engine must still enforce it on delivery.
  return { ...claims, expiresAtMs };
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function readRecord(value: unknown): SubscriptionRecord | undefined {
  const properties = ownData(value);
  if (!properties) return undefined;
  const sub = properties.get('sub');
  const query = properties.get('query');
  const key = properties.get('key');
  const rawTags = properties.get('tags');
  if (!boundedString(sub, 256) || !boundedString(query, 256)) return undefined;
  if (key !== undefined && !boundedString(key, 128)) return undefined;
  if (!Array.isArray(rawTags) || rawTags.length === 0 || rawTags.length > 1000) return undefined;
  const tags: string[] = [];
  for (let index = 0; index < rawTags.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(rawTags, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) return undefined;
    const tag: unknown = descriptor.value;
    if (
      !boundedString(tag, 256) ||
      encoder.encode(tag).byteLength > 256 ||
      /[\u0000-\u001f\u007f]/.test(tag)
    ) {
      return undefined;
    }
    tags.push(tag);
  }
  const rawIdentity = properties.get('identity');
  const identity = rawIdentity === undefined ? undefined : readIdentity(rawIdentity);
  if (rawIdentity !== undefined && identity === undefined) return undefined;

  // Args remain unknown until restore applies the registered query definition.
  // The engine persists original input so transforming parsers can run again.
  // Volatile lastJson/lastCursor are never restored, even if an attachment has them.
  return {
    sub,
    query,
    args: properties.get('args'),
    tags,
    ...(key === undefined ? {} : { key }),
    ...(identity === undefined ? {} : { identity }),
  };
}

export function readPersistedSubscriptionRecords(value: unknown): SubscriptionRecord[] {
  if (!Array.isArray(value)) return [];
  const records: SubscriptionRecord[] = [];
  for (let index = 0; index < value.length; index += 1) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !('value' in descriptor)) continue;
      const candidate: unknown = descriptor.value;
      const record = readRecord(candidate);
      if (record) records.push(record);
    } catch {
      // Malformed attachments cannot escape into restore or execute a query.
    }
  }
  return records;
}
