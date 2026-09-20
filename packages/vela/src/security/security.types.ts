export interface SecurityCorsOptions {
  /** Cross-origin wire methods. Defaults to GET, HEAD, OPTIONS. */
  allowMethods?: string[];
  /** Cross-origin request headers. Defaults to Content-Type and Authorization. */
  allowHeaders?: string[];
  exposeHeaders?: string[];
  /** Emit Access-Control-Allow-Credentials for exact allowed origins. Defaults true. */
  credentials?: boolean;
  /** Preflight cache duration in seconds. Defaults to 600. */
  maxAge?: number;
}

export interface OriginProtectionOptions {
  /** Methods requiring an origin check when ambient credentials are present. */
  unsafeMethods?: string[];
  /** Also treat Authorization as ambient credentials. Defaults false. */
  protectAuthorization?: boolean;
  /** Compatibility escape hatch for non-browser cookie clients. Defaults false. */
  allowMissingOrigin?: boolean;
}

export interface SecurityHeadersOptions {
  noSniff?: boolean;
  referrerPolicy?: string | false;
  frameOptions?: 'DENY' | 'SAMEORIGIN' | false;
  /** Emitted only for HTTPS requests. */
  hsts?: string | false;
  contentSecurityPolicy?: string | false;
}

export interface SecurityModuleOptions {
  /** Exact cross-origin origins. Same-origin is always accepted; wildcard is forbidden. */
  allowedOrigins?: string[];
  /** Set false to disable CORS response/preflight handling. */
  cors?: SecurityCorsOptions | false;
  /** Set false to disable credentialed unsafe-method Origin/CSRF protection. */
  originProtection?: OriginProtectionOptions | false;
  /** Restrictive response headers; individual headers can be disabled explicitly. */
  headers?: SecurityHeadersOptions;
}
