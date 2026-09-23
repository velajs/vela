/**
 * Transport constants shared by the server module, the UI, and the dev host.
 * String literals + one integer version marker; zero runtime dependencies.
 */

/** Default reserved prefix the admin surface mounts under. */
export const STUDIO_DEFAULT_PATH = '/_vela/admin';

/** Unauthenticated health probe suffix (`GET {prefix}/health`). */
export const STUDIO_HEALTH_SUFFIX = '/health';

/** RPC dispatch suffix (`POST {prefix}/rpc/:op`). */
export const STUDIO_RPC_SUFFIX = '/rpc/';

/** Ephemeral WS sub-token mint suffix (`POST {prefix}/ws-token`). */
export const STUDIO_WS_TOKEN_SUFFIX = '/ws-token';

/** Snapshot/transfer export suffix (`GET {prefix}/export`). */
export const STUDIO_EXPORT_SUFFIX = '/export';

/** The header carrying the master bearer token (`Authorization: Bearer <token>`). */
export const STUDIO_TOKEN_HEADER = 'authorization';

/**
 * The wire protocol version. Bumped on any breaking change to the envelope or an
 * op's payload: version 3 labels the default provider lifetime `'default'`
 * instead of `'singleton'`.
 */
export const STUDIO_PROTOCOL_VERSION = 3;
