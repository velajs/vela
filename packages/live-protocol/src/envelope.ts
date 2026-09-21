/** Shared JSON WebSocket envelope. Payloads remain unknown until their own schema parses them. */
export interface WebSocketEnvelope {
  event: string;
  id?: string;
  data?: unknown;
}

/** Read known own data properties only; tolerate extra fields for forward compatibility. */
export function readWebSocketEnvelope(value: unknown): WebSocketEnvelope | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const event = Object.getOwnPropertyDescriptor(value, 'event');
  const id = Object.getOwnPropertyDescriptor(value, 'id');
  const data = Object.getOwnPropertyDescriptor(value, 'data');
  if (!event || !('value' in event) || typeof event.value !== 'string') return undefined;
  const correlation: unknown = id?.value;
  if (id && (!('value' in id) || typeof correlation !== 'string')) return undefined;
  if (data && !('value' in data)) return undefined;
  return {
    event: event.value,
    ...(typeof correlation === 'string' ? { id: correlation } : {}),
    ...(data ? { data: data.value } : {}),
  };
}
