import type { WebSocketGatewayOptions, WebSocketUpgradeIdentity } from './websocket.types';

const PATH_PARAM_RE = /:([A-Za-z_][A-Za-z0-9_]*)/g;

/** Default inbound and outbound WebSocket frame ceiling (64 KiB). */
export const DEFAULT_WS_MAX_FRAME_BYTES = 64 * 1024;
/** Room ids feed routing, hibernation tags, and attachments; keep them bounded. */
export const DEFAULT_WS_MAX_ROOM_ID_BYTES = 512;
/** A socket may belong to at most this many rooms, including its hub room. */
export const DEFAULT_WS_MAX_JOINED_ROOMS = 32;

const encoder = new TextEncoder();
const MAX_UPGRADE_IDENTITY_FIELD_BYTES = 2_048;
const MAX_SOCKET_TICKET_BYTES = 8 * 1_024;
const FORBIDDEN_WEBSOCKET_CREDENTIAL_PARAMS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'bearer',
  'jwt',
  'token',
]);

export interface AuthenticatedWebSocketUpgrade {
  /** Request with credential query parameters removed. */
  request: Request;
  identity: WebSocketUpgradeIdentity;
}

/** Validate a hub or dynamically joined room before it reaches a registry. */
export function assertWebSocketRoomId(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    encoder.encode(value).byteLength > DEFAULT_WS_MAX_ROOM_ID_BYTES
  ) {
    throw new Error('WebSocket room ids must be non-empty, control-free, and at most 512 bytes');
  }
}

/** Resolve and validate the path parameter that owns a gateway room. */
export function resolveGatewayRoomParam(options: WebSocketGatewayOptions): string | undefined {
  const path = options.path ?? '';
  const params = [...path.matchAll(PATH_PARAM_RE)].map((match) => match[1]!);
  const unique = [...new Set(params)];

  if (options.roomParam !== undefined) {
    if (!unique.includes(options.roomParam)) {
      throw new Error(
        `WebSocket gateway roomParam '${options.roomParam}' is not a parameter in path '${path}'`,
      );
    }
    return options.roomParam;
  }

  if (unique.length > 0) {
    throw new Error(
      `WebSocket gateway path '${path}' has parameter${unique.length === 1 ? '' : 's'} ` +
        `(${unique.join(', ')}); set roomParam explicitly`,
    );
  }
  return undefined;
}

/** Resolve one request's room id, rejecting missing parameter values. */
export function resolveGatewayRoomId(
  options: WebSocketGatewayOptions,
  param: (name: string) => string | undefined,
): string {
  const roomParam = resolveGatewayRoomParam(options);
  if (!roomParam) return options.path ?? '';
  const value = param(roomParam);
  try {
    assertWebSocketRoomId(value);
  } catch {
    throw new Error(
      `WebSocket gateway room parameter '${roomParam}' was missing or invalid for '${options.path ?? ''}'`,
    );
  }
  return value;
}

/** Validate the configured frame limit once during gateway discovery. */
export function resolveMaxFrameBytes(options: WebSocketGatewayOptions): number {
  const value = options.maxFrameBytes ?? DEFAULT_WS_MAX_FRAME_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('WebSocket maxFrameBytes must be a positive safe integer');
  }
  return value;
}

/** Measure a text/binary frame without relying on Node-only buffer APIs. */
export function webSocketFrameFits(frame: string | ArrayBuffer, maxFrameBytes: number): boolean {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) return false;
  if (frame instanceof ArrayBuffer) return frame.byteLength <= maxFrameBytes;
  if (typeof frame !== 'string') return false;
  // Every UTF-8 representation is at least as large as the UTF-16 code-unit
  // count for ASCII-heavy protocol frames. Avoid an extra allocation when the
  // cheap lower bound already exceeds the ceiling.
  if (frame.length > maxFrameBytes) return false;
  return encoder.encode(frame).byteLength <= maxFrameBytes;
}

/**
 * Fail closed for browser origins. With no explicit allowlist, browser
 * WebSockets are same-origin; non-browser clients without Origin remain valid.
 */
export function isWebSocketOriginAllowed(
  request: Request,
  allowedOrigins?: '*' | readonly string[],
): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  if (allowedOrigins === '*') return true;

  let normalized: string;
  try {
    normalized = new URL(origin).origin;
  } catch {
    return false;
  }

  if (allowedOrigins) {
    return allowedOrigins.some((candidate) => {
      try {
        return new URL(candidate).origin === normalized;
      } catch {
        return false;
      }
    });
  }

  return normalized === new URL(request.url).origin;
}

/** Run origin and optional application authorization before socket allocation. */
export async function authorizeWebSocketUpgrade(
  options: WebSocketGatewayOptions,
  request: Request,
): Promise<boolean> {
  if (!isWebSocketOriginAllowed(request, options.allowedOrigins)) return false;
  if (!options.authorizeUpgrade) return true;
  try {
    return (await options.authorizeUpgrade(request)) === true;
  } catch {
    return false;
  }
}

/**
 * Complete pre-allocation WebSocket trust boundary. It rejects bearer-like
 * query credentials, removes the one supported short-lived `ticket`, runs
 * Origin + application authorization, and validates the returned identity.
 */
export async function authenticateWebSocketUpgrade(
  options: WebSocketGatewayOptions,
  request: Request,
  room: string,
): Promise<AuthenticatedWebSocketUpgrade | false> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;

  for (const key of url.searchParams.keys()) {
    const normalized = key.toLowerCase();
    if (
      FORBIDDEN_WEBSOCKET_CREDENTIAL_PARAMS.has(normalized) ||
      (normalized === 'ticket' && key !== 'ticket')
    ) {
      return false;
    }
  }
  const tickets = url.searchParams.getAll('ticket');
  if (
    tickets.length > 1 ||
    tickets.some(
      (ticket) =>
        ticket.length === 0 ||
        !/^[\x21-\x7e]+$/.test(ticket) ||
        encoder.encode(ticket).byteLength > MAX_SOCKET_TICKET_BYTES,
    )
  ) {
    return false;
  }
  const ticket = tickets[0];
  url.searchParams.delete('ticket');

  let sanitized: Request;
  try {
    sanitized = new Request(url.toString(), request);
  } catch {
    return false;
  }
  if (!(await authorizeWebSocketUpgrade(options, sanitized))) return false;

  // Origin checks alone are not authentication. Every successful upgrade
  // must install a finite-lived principal+tenant identity before allocation.
  if (!options.authenticateUpgrade) return false;

  let candidate: WebSocketUpgradeIdentity | false;
  try {
    candidate = await options.authenticateUpgrade(sanitized, {
      gatewayPath: options.path ?? '',
      room,
      ...(ticket === undefined ? {} : { ticket }),
    });
  } catch {
    return false;
  }
  const identity = normalizeWebSocketUpgradeIdentity(candidate);
  return identity === false ? false : { request: sanitized, identity };
}

/** Validate trusted attachment/client data before every frame or push. */
export function normalizeWebSocketUpgradeIdentity(
  value: unknown,
): WebSocketUpgradeIdentity | false {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const principal = candidate.principal;
  if (!principal || typeof principal !== 'object') return false;
  const fields = principal as Record<string, unknown>;
  if (
    !isIdentityField(fields.issuer) ||
    !isIdentityField(fields.subject) ||
    (fields.principalType !== 'user' && fields.principalType !== 'service') ||
    !isIdentityField(candidate.tenantId) ||
    typeof candidate.expiresAtMs !== 'number' ||
    !Number.isSafeInteger(candidate.expiresAtMs) ||
    candidate.expiresAtMs <= Date.now()
  ) {
    return false;
  }
  return {
    principal: {
      issuer: fields.issuer,
      subject: fields.subject,
      principalType: fields.principalType,
    },
    tenantId: candidate.tenantId,
    expiresAtMs: candidate.expiresAtMs,
  };
}

function isIdentityField(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    encoder.encode(value).byteLength <= MAX_UPGRADE_IDENTITY_FIELD_BYTES
  );
}
