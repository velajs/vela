import { AgentError } from './errors';
import type { AgentRunParams } from './types';

/** Leave headroom below a workflow's serialized step-result limit. */
export const MAX_VALUE_BYTES = 256 * 1024;

/** Validate finite JSON before persisting or hashing external data. */
export const canonicalJson = (value: unknown): string => {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > 10000 || depth > 32) throw new TypeError('JSON is too complex');
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || seen.has(item)) throw new TypeError('Expected finite JSON');
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        return `[${Array.from(item, (entry) => visit(entry, depth + 1)).join(',')}]`;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError('Expected plain JSON');
      return `{${Object.keys(item)
        .sort()
        .map((key) => {
          const property = Object.getOwnPropertyDescriptor(item, key);
          if (!property || !('value' in property))
            throw new TypeError('JSON getters are unsupported');
          return `${JSON.stringify(key)}:${visit(property.value, depth + 1)}`;
        })
        .join(',')}}`;
    } finally {
      seen.delete(item);
    }
  };
  try {
    const json = visit(value, 0);
    boundedText(json);
    return json;
  } catch (cause) {
    throw new AgentError('AGENT_INVALID_DATA', 'Expected bounded finite JSON data', {
      status: 400,
      cause,
    });
  }
};

export const boundedText = (value: unknown): string => {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > MAX_VALUE_BYTES) {
    throw new AgentError(
      'AGENT_INVALID_DATA',
      `Expected a string of at most ${MAX_VALUE_BYTES} UTF-8 bytes`,
      { status: 400 },
    );
  }
  return value;
};

export const digestJson = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const parseAgentRunParams = (value: unknown): AgentRunParams => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentError('AGENT_INVALID_DATA', 'Expected agent run parameters');
  }
  const get = (key: string): unknown => Reflect.get(value, key);
  const threadKey = get('threadKey');
  const input = get('input');
  if (
    typeof threadKey !== 'string' ||
    !threadKey.length ||
    threadKey.length > 256 ||
    threadKey !== threadKey.trim()
  ) {
    throw new AgentError(
      'AGENT_INVALID_DATA',
      'Expected a canonical threadKey of at most 256 characters',
    );
  }
  const result: AgentRunParams = { threadKey, input: boundedText(input) };
  for (const key of ['runKey', 'owner', 'tenantId', 'title'] as const) {
    const field = get(key);
    if (field === undefined) continue;
    if (
      typeof field !== 'string' ||
      field.length === 0 ||
      field.length > 256 ||
      field !== field.trim()
    ) {
      throw new AgentError(
        'AGENT_INVALID_DATA',
        `Expected a canonical ${key} of at most 256 characters`,
      );
    }
    result[key] = field;
  }
  return result;
};
