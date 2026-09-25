// @velajs/vela/security — browser and HTTP hardening (SecurityModule),
// secrets, HMAC signed URLs and the single-use nonce store.
import '../metadata';

export { SecurityModule } from './security.module';
export { Secret } from './secret';
export { SECURITY_OPTIONS } from './security.tokens';
export { buildSecurityMiddleware } from './security.middleware';
export type {
  SecurityModuleOptions,
  SecurityCorsOptions,
  OriginProtectionOptions,
  SecurityHeadersOptions,
} from './security.types';

// Edge-safe HMAC signed-URL primitives
export { signUrl, verifySignedUrl, HTTP_SIGNED_URL_PURPOSE } from '../crypto/signed-url';
export type { SignedUrlOptions, VerifySignedUrlOptions } from '../crypto/signed-url';

// Single-use nonces (signed invocations, WebSocket tickets)
export { MemoryNonceStore, NONCE_STORE } from '../dispatch/nonce-store';
export type { NonceStore } from '../dispatch/types';
