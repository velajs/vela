import type { Context, Next } from 'hono';
import type { NestMiddleware } from '../pipeline/types';
import type {
  OriginProtectionOptions,
  SecurityCorsOptions,
  SecurityHeadersOptions,
  SecurityModuleOptions,
} from './security.types';

const DEFAULT_CORS_METHODS = ['GET', 'HEAD', 'OPTIONS'];
const DEFAULT_CORS_HEADERS = ['content-type', 'authorization'];
const DEFAULT_UNSAFE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

const DEFAULT_HEADERS: Required<SecurityHeadersOptions> = {
  noSniff: true,
  referrerPolicy: 'no-referrer',
  frameOptions: 'DENY',
  hsts: 'max-age=31536000; includeSubDomains',
  contentSecurityPolicy:
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

interface NormalizedSecurityOptions {
  allowedOrigins: Set<string>;
  cors: false | Required<SecurityCorsOptions>;
  originProtection: false | Required<OriginProtectionOptions>;
  headers: Required<SecurityHeadersOptions>;
}

type PrioritizedMiddleware = NestMiddleware & { priority: number };

function assertHeaderValue(name: string, value: string | false): void {
  if (value !== false && (value.length === 0 || /[\r\n]/.test(value))) {
    throw new Error(`${name} must be a non-empty single-line header value, or false`);
  }
}

function normalizeConfiguredOrigin(origin: string): string {
  if (origin === '*') throw new Error('SecurityModule does not allow wildcard origins');
  try {
    const parsed = new URL(origin);
    if (
      parsed.origin === 'null' ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('not an origin');
    }
    return parsed.origin;
  } catch {
    throw new Error(`SecurityModule allowedOrigins contains an invalid origin: ${origin}`);
  }
}

function normalizeTokenList(name: string, values: string[]): string[] {
  if (values.length === 0) throw new Error(`${name} must not be empty`);
  return values.map((value) => {
    const normalized = value.trim().toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(normalized)) {
      throw new Error(`${name} contains an invalid token: ${value}`);
    }
    return normalized;
  });
}

function normalizeMethods(name: string, methods: string[]): string[] {
  if (methods.length === 0) throw new Error(`${name} must not be empty`);
  return methods.map((method) => {
    const normalized = method.toUpperCase();
    if (!/^[A-Z]+$/.test(normalized)) throw new Error(`${name} contains an invalid method`);
    return normalized;
  });
}

function normalizeOptions(options: SecurityModuleOptions): NormalizedSecurityOptions {
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map(normalizeConfiguredOrigin));
  const cors =
    options.cors === false
      ? false
      : {
          allowMethods: normalizeMethods(
            'security.cors.allowMethods',
            options.cors?.allowMethods ?? DEFAULT_CORS_METHODS,
          ),
          allowHeaders: normalizeTokenList(
            'security.cors.allowHeaders',
            options.cors?.allowHeaders ?? DEFAULT_CORS_HEADERS,
          ),
          exposeHeaders: normalizeTokenList(
            'security.cors.exposeHeaders',
            options.cors?.exposeHeaders ?? ['content-type'],
          ),
          credentials: options.cors?.credentials ?? true,
          maxAge: options.cors?.maxAge ?? 600,
        };
  if (cors !== false && (!Number.isSafeInteger(cors.maxAge) || cors.maxAge < 0)) {
    throw new Error('security.cors.maxAge must be a non-negative safe integer');
  }

  const originProtection =
    options.originProtection === false
      ? false
      : {
          unsafeMethods: normalizeMethods(
            'security.originProtection.unsafeMethods',
            options.originProtection?.unsafeMethods ?? DEFAULT_UNSAFE_METHODS,
          ),
          protectAuthorization: options.originProtection?.protectAuthorization ?? false,
          allowMissingOrigin: options.originProtection?.allowMissingOrigin ?? false,
        };

  const headers = { ...DEFAULT_HEADERS, ...(options.headers ?? {}) };
  assertHeaderValue('security.headers.referrerPolicy', headers.referrerPolicy);
  assertHeaderValue('security.headers.frameOptions', headers.frameOptions);
  assertHeaderValue('security.headers.hsts', headers.hsts);
  assertHeaderValue('security.headers.contentSecurityPolicy', headers.contentSecurityPolicy);
  return { allowedOrigins, cors, originProtection, headers };
}

function requestOrigin(value: string | undefined): string | undefined {
  if (!value || value === 'null') return undefined;
  try {
    const parsed = new URL(value);
    return parsed.origin === 'null' ? undefined : parsed.origin;
  } catch {
    return undefined;
  }
}

function mergeVary(c: Context, value: string): void {
  const current = c.res.headers.get('vary');
  const entries = new Set(
    (current ? current.split(',') : []).map((entry) => entry.trim()).filter(Boolean),
  );
  entries.add(value);
  c.header('Vary', [...entries].join(', '));
}

function applySecurityHeaders(c: Context, headers: Required<SecurityHeadersOptions>): void {
  if (headers.noSniff) c.header('X-Content-Type-Options', 'nosniff');
  if (headers.referrerPolicy !== false) c.header('Referrer-Policy', headers.referrerPolicy);
  if (headers.frameOptions !== false) c.header('X-Frame-Options', headers.frameOptions);
  if (headers.contentSecurityPolicy !== false) {
    c.header('Content-Security-Policy', headers.contentSecurityPolicy);
  }
  if (headers.hsts !== false && new URL(c.req.raw.url).protocol === 'https:') {
    c.header('Strict-Transport-Security', headers.hsts);
  }
}

function forbidden(c: Context, message: string): Response {
  return c.json({ error: { code: 'forbidden', message } }, 403);
}

export function buildSecurityMiddleware(options: SecurityModuleOptions): PrioritizedMiddleware {
  const normalized = normalizeOptions(options);

  return {
    // Run before ordinary application middleware so rejected cross-origin
    // requests cannot trigger state changes or expensive work.
    priority: -10_000,
    async use(c: Context, next: Next): Promise<Response | void> {
      const targetOrigin = new URL(c.req.raw.url).origin;
      const rawOrigin = c.req.header('origin');
      const origin = requestOrigin(rawOrigin);
      const hasOrigin = rawOrigin !== undefined;
      const originAllowed =
        origin === targetOrigin || (origin && normalized.allowedOrigins.has(origin));

      if (hasOrigin && !originAllowed) {
        const response = forbidden(c, 'Origin is not allowed');
        applySecurityHeaders(c, normalized.headers);
        return response;
      }

      const preflightMethod = c.req.header('access-control-request-method')?.toUpperCase();
      if (c.req.method === 'OPTIONS' && preflightMethod) {
        if (normalized.cors === false || !origin || !originAllowed) {
          const response = forbidden(c, 'CORS preflight is not allowed');
          applySecurityHeaders(c, normalized.headers);
          return response;
        }
        const cors = normalized.cors;
        if (!cors.allowMethods.includes(preflightMethod)) {
          const response = forbidden(c, 'CORS method is not allowed');
          applySecurityHeaders(c, normalized.headers);
          return response;
        }
        const requestedHeaders = (c.req.header('access-control-request-headers') ?? '')
          .split(',')
          .map((header) => header.trim().toLowerCase())
          .filter(Boolean);
        if (requestedHeaders.some((header) => !cors.allowHeaders.includes(header))) {
          const response = forbidden(c, 'CORS header is not allowed');
          applySecurityHeaders(c, normalized.headers);
          return response;
        }

        c.header('Access-Control-Allow-Origin', origin);
        c.header('Access-Control-Allow-Methods', cors.allowMethods.join(', '));
        c.header('Access-Control-Allow-Headers', cors.allowHeaders.join(', '));
        c.header('Access-Control-Max-Age', String(cors.maxAge));
        if (cors.credentials) c.header('Access-Control-Allow-Credentials', 'true');
        mergeVary(c, 'Origin');
        applySecurityHeaders(c, normalized.headers);
        return c.body(null, 204);
      }

      if (
        origin &&
        origin !== targetOrigin &&
        normalized.cors !== false &&
        !normalized.cors.allowMethods.includes(c.req.method.toUpperCase())
      ) {
        const response = forbidden(c, 'CORS method is not allowed');
        applySecurityHeaders(c, normalized.headers);
        return response;
      }

      if (normalized.originProtection !== false) {
        const credentialed = Boolean(
          c.req.header('cookie') ||
          (normalized.originProtection.protectAuthorization && c.req.header('authorization')),
        );
        if (
          credentialed &&
          normalized.originProtection.unsafeMethods.includes(c.req.method.toUpperCase()) &&
          (hasOrigin ? !originAllowed : !normalized.originProtection.allowMissingOrigin)
        ) {
          const response = forbidden(c, 'Credentialed state change requires an allowed Origin');
          applySecurityHeaders(c, normalized.headers);
          return response;
        }
      }

      try {
        await next();
      } finally {
        if (normalized.cors !== false && origin && originAllowed) {
          c.header('Access-Control-Allow-Origin', origin);
          if (normalized.cors.credentials) c.header('Access-Control-Allow-Credentials', 'true');
          if (normalized.cors.exposeHeaders.length > 0) {
            c.header('Access-Control-Expose-Headers', normalized.cors.exposeHeaders.join(', '));
          }
          mergeVary(c, 'Origin');
        }
        applySecurityHeaders(c, normalized.headers);
      }
    },
  };
}
