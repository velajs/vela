/**
 * Injection tokens + metadata keys for the Studio module. Kept in one place so
 * providers, the route contributor, and tests share a single identity per token.
 */
import { InjectionToken } from '@velajs/vela';
import type { Container } from '@velajs/vela/module-kit';
import type { ResolvedStudioConfig } from './studio.types';
import type { AdminAuditEntry } from '@velajs/studio-protocol';

/**
 * The application's own container, as `app.get(Container)` returns it. Studio
 * and its panels inject it instead of `Container` and read the framework
 * tokens (`ENV`, `APP_LOGGER`, `ROOT_MODULE`, `DiscoveryService`,
 * `EntrypointRegistry`) through it, application-wide as `app.get()` does: an
 * explicit application registration, such as a seeded `ENV`, answers first,
 * then the `@Global()` module exporting the token, which overrides a framework
 * default such as `ROOT_MODULE` for `app.get()` and Studio alike. In
 * StudioModule's scope a module a plugin imports would answer first instead.
 * StudioModule provides this token itself, and fails bootstrap when a
 * `@Global()` module exports another `Container`.
 */
export const STUDIO_APPLICATION_CONTAINER = new InjectionToken<Container>(
  'STUDIO_APPLICATION_CONTAINER',
);

/** The resolved (env + options) Studio config. */
export const STUDIO_RESOLVED_CONFIG = new InjectionToken<ResolvedStudioConfig>(
  'STUDIO_RESOLVED_CONFIG',
);

/**
 * Test-only escape hatch: extra op names the dispatch registry accepts at
 * bootstrap in addition to `STUDIO_OPS`. Never provided in production — it
 * exists so tests can register `@AdminRpc` handlers under fake op names without
 * widening the frozen op catalog. Read from the root container at bootstrap.
 */
export const STUDIO_TEST_ONLY_OPS = new InjectionToken<readonly string[]>('STUDIO_TEST_ONLY_OPS');

/** Optional best-effort audit sink. When provided, every audit row is mirrored to it. */
export interface AdminAuditSink {
  write(entry: AdminAuditEntry): void | Promise<void>;
}

/** Injection token for an optional {@link AdminAuditSink}. */
export const ADMIN_AUDIT_SINK = new InjectionToken<AdminAuditSink>('ADMIN_AUDIT_SINK');

/** Class-level metadata key the route contributor claims to mount the admin surface. */
export const STUDIO_ADMIN_META = 'vela:studio:admin-surface';
