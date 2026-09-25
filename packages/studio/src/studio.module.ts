import { ModuleRef, defineProvider, defineModule } from '@velajs/vela';
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
import { Container, ROOT_MODULE } from '@velajs/vela/module-kit';
import type { ProviderDefinition, Type } from '@velajs/vela';
import { resolveStudioConfig, StudioEnvReader } from './studio.config';
import type { StudioModuleOptions } from './studio.types';
import { collectStudioPlugins, providerToken } from './plugin';
import { ADMIN_AUDIT_SINK, STUDIO_APPLICATION_CONTAINER, STUDIO_RESOLVED_CONFIG } from './tokens';
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

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<
  StudioModuleOptions,
  'plugins'
>({
  name: 'Studio',
  // Plugins decide the providers, so forRootAsync takes them next to its factory.
  structural: ['plugins'],
  defaults: { plugins: [] },
  // One admin surface per application, whatever its panels: a second
  // configuration fails bootstrap instead of mounting another surface.
  key: () => 'application',
  setup: ({ OPTIONS, options }) => {
    const core: Array<Type | ProviderDefinition> = [
      // The application's container, looked up application-wide as app.get()
      // does: Studio and its panels read the framework tokens through it, so a
      // module a plugin imports never answers for them inside this scope.
      defineProvider(STUDIO_APPLICATION_CONTAINER, {
        useFactory: (ref: ModuleRef) => ref.get(Container, { strict: false }),
        inject: [ModuleRef],
      }),
      // Env-derived config slice (reads VELA_STUDIO_* from the optional ENV).
      StudioEnvReader,
      // Resolved config = env UNDER module options; OpenAPI documents the
      // application's root unless the options name a narrower module.
      defineProvider(STUDIO_RESOLVED_CONFIG, {
        useFactory: (env: StudioEnvReader, settings: StudioModuleOptions, application: Container) =>
          resolveStudioConfig(env.config, settings, application.resolve(ROOT_MODULE)),
        inject: [StudioEnvReader, OPTIONS, STUDIO_APPLICATION_CONTAINER],
      }),
      defineProvider(AdminSubTokenSigner, {
        useFactory: (config: ResolvedStudioConfig) =>
          new AdminSubTokenSigner(config.token ?? '', { ttlSec: config.subTokenTtlSec }),
        inject: [STUDIO_RESOLVED_CONFIG],
      }),
      defineProvider(ConfirmTokenSigner, {
        useFactory: (config: ResolvedStudioConfig) => new ConfirmTokenSigner(config.token ?? ''),
        inject: [STUDIO_RESOLVED_CONFIG],
      }),
      defineProvider(AdminAuditLog, {
        useFactory: (config: ResolvedStudioConfig, application: Container) =>
          new AdminAuditLog(config.auditBufferSize, resolveSink(application)),
        inject: [STUDIO_RESOLVED_CONFIG, STUDIO_APPLICATION_CONTAINER],
      }),
      defineProvider(AdminLogBuffer, {
        useFactory: (config: ResolvedStudioConfig) => new AdminLogBuffer(config.logBufferSize),
        inject: [STUDIO_RESOLVED_CONFIG],
      }),
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
      // (the `@velajs/studio/crud` subpath's crudPanel(), or a BYO source).
      StudioDataOps,
      // Time-travel ops. Registered unconditionally (stable wire surface); each
      // reports TIMETRAVEL_UNAVAILABLE until a TIME_TRAVEL_PORT is bound (the
      // `@velajs/studio/timetravel` timeTravelPanel(), or the Durable Object
      // PITR cloudflareTimeTravelPanel()).
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
    // A panel never replaces these: providing one of their tokens fails here.
    const plugins = collectStudioPlugins(options.plugins, [OPTIONS, ...core.map(providerToken)]);

    return {
      imports: plugins.flatMap((plugin) => plugin.imports ?? []),
      // Each panel's ops and ports, in this module's scope: they inject the
      // signers, buffers and resolved config above directly.
      providers: [...core, ...plugins.flatMap((plugin) => plugin.providers ?? [])],
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

/**
 * The Studio admin surface. Panels join through one contract,
 * `StudioModule.forRoot({ plugins: [queuesPanel(), livePanel(), ...] })`: each
 * plugin's providers register in this module's scope. `plugins` is structural.
 */
export class StudioModule extends ConfigurableModuleClass {}
export { MODULE_OPTIONS_TOKEN as STUDIO_MODULE_OPTIONS };
