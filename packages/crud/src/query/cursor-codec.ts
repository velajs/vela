import { InputValidationException } from '../envelope/errors';
export interface CursorBinding {
  resource: string;
  ordering: readonly { field: string; direction: 'asc' | 'desc' }[];
  tenantId?: string;
  parents?: Readonly<Record<string, string>>;
}
export interface CursorCodec {
  encode(payload: string, binding: CursorBinding): Promise<string>;
  decode(token: string, binding: CursorBinding): Promise<string>;
}
const encoder = new TextEncoder();
function b64(value: Uint8Array): string {
  return btoa(Array.from(value, (v) => String.fromCharCode(v)).join(''))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
function unb64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url');
  const result = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
    c.charCodeAt(0),
  );
  if (b64(result) !== value) throw new Error('Noncanonical base64url');
  return result;
}
function context(binding: CursorBinding): string {
  return JSON.stringify([
    binding.resource,
    binding.ordering.map((o) => [o.field, o.direction]),
    binding.tenantId ?? null,
    Object.entries(binding.parents ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);
}
/** Keys belong to an application/environment instance. Rotation retains old verify keys. */
export function hmacCursorCodec(options: {
  activeKeyId: string;
  keys: ReadonlyMap<string, CryptoKey>;
  maxAgeMs?: number;
  now?: () => number;
}): CursorCodec {
  const keys = new Map(options.keys),
    now = options.now ?? Date.now;
  const activeKeyId = options.activeKeyId;
  const age = options.maxAgeMs ?? 86_400_000;
  if (!Number.isSafeInteger(age) || age <= 0 || !keys.get(activeKeyId)?.usages.includes('sign'))
    throw new TypeError('Invalid cursor key configuration');
  for (const [id, key] of keys)
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
      key.algorithm.name !== 'HMAC' ||
      !('hash' in key.algorithm) ||
      !key.algorithm.hash ||
      typeof key.algorithm.hash !== 'object' ||
      !('name' in key.algorithm.hash) ||
      key.algorithm.hash.name !== 'SHA-256' ||
      !('length' in key.algorithm) ||
      typeof key.algorithm.length !== 'number' ||
      key.algorithm.length < 256 ||
      !key.usages.includes('verify')
    )
      throw new TypeError('Invalid cursor key');
  return {
    async encode(payload, binding) {
      const data = b64(
        encoder.encode(
          JSON.stringify({
            v: 1,
            key: activeKeyId,
            at: now(),
            context: context(binding),
            payload,
          }),
        ),
      );
      const signature = await crypto.subtle.sign(
        'HMAC',
        keys.get(activeKeyId)!,
        encoder.encode(data),
      );
      return `${data}.${b64(new Uint8Array(signature))}`;
    },
    async decode(token, binding) {
      try {
        if (token.length > 32768) throw new Error('Oversized cursor');
        const [data, signature, ...rest] = token.split('.');
        if (!data || !signature || rest.length) throw new Error('Malformed cursor');
        const value: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(unb64(data)),
        );
        if (
          !value ||
          typeof value !== 'object' ||
          !('v' in value) ||
          value.v !== 1 ||
          !('key' in value) ||
          typeof value.key !== 'string' ||
          !('at' in value) ||
          typeof value.at !== 'number' ||
          !Number.isSafeInteger(value.at) ||
          !('context' in value) ||
          value.context !== context(binding) ||
          !('payload' in value) ||
          typeof value.payload !== 'string'
        )
          throw new Error('Invalid cursor');
        const key = keys.get(value.key);
        if (
          !key ||
          value.at > now() ||
          now() - value.at > age ||
          !(await crypto.subtle.verify('HMAC', key, unb64(signature), encoder.encode(data)))
        )
          throw new Error('Invalid signature');
        return value.payload;
      } catch {
        throw new InputValidationException('Invalid or expired cursor');
      }
    },
  };
}
