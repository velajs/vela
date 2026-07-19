/**
 * `StudioModule` — mounts the reserved `/_vela/admin` surface with its full
 * security chain, the `@AdminRpc` dispatch registry (empty catalog in M2), and
 * the token/sub-token/confirm-token primitives.
 *
 * Authored 100% against the public `@velajs/vela` barrel (the openness rule — an
 * audit test asserts no deep `../` imports into vela internals). EAGER by design:
 * the dispatch registry's `onApplicationBootstrap` builds the op map and the
 * route contributor mounts routes at build time.
 */
import { Container, defineModule } from '@velajs/vela';
import type { ProviderOptions, Type } from '@velajs/vela';
import { resolveStudioConfig, studioConfig } from './studio.config';
import type { StudioModuleOptions } from './studio.types';
import type { StudioEnvConfig } from './studio.config';
import { ADMIN_AUDIT_SINK, STUDIO_RESOLVED_CONFIG } from './tokens';
import type { AdminAuditSink } from './tokens';
import { AdminSubTokenSigner } from './security/sub-token.signer';
import { ConfirmTokenSigner } from './security/confirm-token';
import { AdminAuditLog } from './audit/audit-log';
import { AdminLogBuffer } from './logs/log-buffer';
import { StudioDispatchRegistry } from './rpc/dispatch.registry';
import { StudioFeaturesService } from './features/features.service';
import { StudioAppHolder } from './introspect/app-holder';
import { StudioAppOps } from './ops/app.ops';
import { StudioLogsOps } from './ops/logs.ops';
import { StudioCapabilitiesOps } from './ops/studio.ops';
import { StudioDataOps } from './data/data.ops';
import { StudioTimeTravelOps } from './timetravel/timetravel.ops';
import { StudioAuthOps } from './auth/auth.ops';
import { StudioTransferOps } from './transfer/transfer.ops';
// Importing the marker controller pulls the route-contributor module (and its
// import-time `registerRouteContributor` side effect) into the graph.
import { StudioAdminController } from './http/route-contributor';
import type { ResolvedStudioConfig } from './studio.types';

function resolveSink(container: Container): AdminAuditSink | undefined {
  return container.has(ADMIN_AUDIT_SINK) ? container.resolve(ADMIN_AUDIT_SINK) : undefined;
}

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<StudioModuleOptions>({
  name: 'Studio',
  setup: ({ OPTIONS }) => {
    const providers: Array<Type | ProviderOptions> = [
      // Env-derived config slice (reads VELA_STUDIO_* via CONFIG_ENV).
      studioConfig.asProvider(),
      // Resolved config = env UNDER module options.
      {
        provide: STUDIO_RESOLVED_CONFIG,
        useFactory: (env: StudioEnvConfig, options: StudioModuleOptions) =>
          resolveStudioConfig(env, options),
        inject: [studioConfig.KEY, OPTIONS],
      },
      {
        provide: AdminSubTokenSigner,
        useFactory: (config: ResolvedStudioConfig) =>
          new AdminSubTokenSigner(config.token ?? '', { ttlSec: config.subTokenTtlSec }),
        inject: [STUDIO_RESOLVED_CONFIG],
      },
      {
        provide: ConfirmTokenSigner,
        useFactory: (config: ResolvedStudioConfig) => new ConfirmTokenSigner(config.token ?? ''),
        inject: [STUDIO_RESOLVED_CONFIG],
      },
      {
        provide: AdminAuditLog,
        useFactory: (config: ResolvedStudioConfig, container: Container) =>
          new AdminAuditLog(config.auditBufferSize, resolveSink(container)),
        inject: [STUDIO_RESOLVED_CONFIG, Container],
      },
      {
        provide: AdminLogBuffer,
        useFactory: (config: ResolvedStudioConfig) => new AdminLogBuffer(config.logBufferSize),
        inject: [STUDIO_RESOLVED_CONFIG],
      },
      StudioFeaturesService,
      StudioDispatchRegistry,
      // Introspection seam + the M4 op providers. The dispatch registry
      // discovers their `@AdminRpc` methods at bootstrap and resolves each
      // per call; the holder is populated at mount time by the contributor.
      StudioAppHolder,
      StudioAppOps,
      StudioLogsOps,
      StudioCapabilitiesOps,
      // Data-browser READ ops. Registered unconditionally (stable wire surface);
      // each reports FEATURE_UNCONFIGURED until a STUDIO_MODEL_SOURCE is bound
      // (the `@velajs/studio/crud` subpath's StudioCrudModule, or a BYO source).
      StudioDataOps,
      // Time-travel ops. Registered unconditionally (stable wire surface); each
      // reports TIMETRAVEL_UNAVAILABLE until a TIME_TRAVEL_PORT is bound (the
      // opt-in `@velajs/studio/timetravel` StudioTimeTravelModule, or a CF-DO
      // PITR module in M11).
      StudioTimeTravelOps,
      // Auth panel ops (M9). Registered unconditionally against STUDIO_AUTH_SOURCE
      // (the port); each reports FEATURE_UNCONFIGURED until the
      // `@velajs/studio/auth` subpath binds a better-auth-backed source. The
      // core `.` entry never imports better-auth — only the subpath does.
      StudioAuthOps,
      // Transfer ops (M9): export (a URL to the /export route) + import (bulk
      // NDJSON ingest). Registered unconditionally against STUDIO_MODEL_SOURCE;
      // each reports FEATURE_UNCONFIGURED until a source is bound.
      StudioTransferOps,
    ];

    return {
      providers,
      controllers: [StudioAdminController],
      exports: [
        STUDIO_RESOLVED_CONFIG,
        AdminSubTokenSigner,
        ConfirmTokenSigner,
        AdminAuditLog,
        AdminLogBuffer,
        StudioFeaturesService,
        StudioDispatchRegistry,
        StudioAppHolder,
      ],
    };
  },
});

export class StudioModule extends ConfigurableModuleClass {}
export { MODULE_OPTIONS_TOKEN as STUDIO_MODULE_OPTIONS };
