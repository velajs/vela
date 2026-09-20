export interface ErrorCatalogEntry {
  status: number;
  title: string;
  hint?: string;
  docsUrl?: string;
  /** Redaction posture: true → message/hint/data are never echoed to clients. */
  internal?: boolean;
}

export const CORE_ENTRIES = {
  bad_request: { status: 400, title: 'Bad Request' },
  unauthorized: { status: 401, title: 'Unauthorized' },
  forbidden: { status: 403, title: 'Forbidden' },
  not_found: { status: 404, title: 'Not Found' },
  method_not_allowed: { status: 405, title: 'Method Not Allowed' },
  conflict: { status: 409, title: 'Conflict' },
  gone: { status: 410, title: 'Gone' },
  payload_too_large: { status: 413, title: 'Payload Too Large' },
  unsupported_media_type: { status: 415, title: 'Unsupported Media Type' },
  unprocessable: { status: 422, title: 'Unprocessable Entity' },
  too_many_requests: { status: 429, title: 'Too Many Requests' },
  internal: { status: 500, title: 'Internal Server Error', internal: true },
  not_implemented: { status: 501, title: 'Not Implemented' },
  bad_gateway: { status: 502, title: 'Bad Gateway' },
  service_unavailable: { status: 503, title: 'Service Unavailable' },
  gateway_timeout: { status: 504, title: 'Gateway Timeout' },
} as const satisfies Record<string, ErrorCatalogEntry>;

export type CoreErrorCode = keyof typeof CORE_ENTRIES;
