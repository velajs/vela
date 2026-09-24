// @velajs/vela/module-kit — the seams for authors of modules, integrations,
// runtime adapters and tooling: metadata, discovery, entrypoint kinds, execution
// scopes, route contributors, the request pipeline runner and module-authoring
// helpers. Applications rarely need it; everything here is part of the public,
// semver-covered surface.
import './metadata';

// Decoration metadata. MetadataRegistry is the central decoration store; it
// holds no application state, so tests need no cleanup between cases.
export { defineMetadata, getMetadata } from './metadata';
export { MetadataRegistry } from './registry/metadata.registry';
export { METADATA_KEYS, HttpMethod, ParamType } from './constants';

// The dependency-injection container behind every execution scope
// (`getRequestContainer`, `runInEntrypointScope`, discovery's `requestScope`),
// plus helpers and diagnostics
export {
  Container,
  assertFactoryInject,
  describeToken,
  MissingInjectionMetadataError,
  ModuleVisibilityError,
  MultipleProvidersFoundError,
  UnresolvedDependencyError,
} from './container/index';
export type {
  InferToken,
  InferTokens,
  FactoryInject,
  CheckedProviders,
  MissingInjectionMetadataReason,
  UnresolvedDependency,
  UnresolvedDependencyReason,
  ModuleDescription,
} from './container/index';

// Module authoring
export {
  sideEffectModule,
  lazyProvider,
  referenceKey,
  stableHash,
  UndefinedModuleError,
  ROOT_MODULE,
} from './module/index';
export type { LazyProviderSpec, ModuleEntryList } from './module/index';

// Discovery — decorator-driven provider discovery
export { DiscoveryService, createDiscoverableDecorator } from './discovery/index';
export type {
  DiscoveredClass,
  DiscoveredRegistration,
  DiscoveredRegisteredMethodMeta,
  DiscoveredMethodMeta,
  DiscoveryFilter,
  DiscoverableDecorator,
  CreateDiscoverableDecoratorOptions,
} from './discovery/index';

// Entrypoints — the open non-HTTP entry surface (websocket, queue, cron, …)
export {
  EntrypointRegistry,
  registerEntrypointKind,
  getEntrypointKinds,
  contributesEntrypoints,
  runInEntrypointScope,
  createExecutionScope,
  getExecutionLifetime,
  finishExecutionScope,
  getEntrypointModuleId,
  resolveEntrypoint,
  buildEntrypointExecutionContext,
} from './entrypoint/index';
export type {
  ContributesEntrypoints,
  Entrypoint,
  EntrypointKind,
  EntrypointExecutionContext,
  ExecutionScope,
  ExecutionScopeOptions,
} from './entrypoint/index';

// Runtime adapters — platform bindings for VelaFactory.create({ adapters })
export type { AdapterContext, RuntimeAdapter } from './factory/adapter';

// Scheduled-job seams for runtime adapters and tooling
export { invokeScheduledJob } from './schedule/schedule.invoke';
export type { InvokeScheduledJobOptions } from './schedule/schedule.invoke';
export { parseCronMetadata, parseIntervalMetadata } from './schedule/schedule.metadata';
export { cronDialectAmbiguity, scheduledJobComponents } from './schedule/schedule.diagnostics';
export { SCHEDULE_INVOCATION_SEED } from './schedule/schedule.tokens';
export type { ScheduleInvocationSeed } from './schedule/schedule.types';

// Route contribution — metadata-claimed route generators (@Crud-style)
export { registerRouteContributor, getRouteContributors } from './http/route-contributor';
export type {
  RouteContributor,
  RouteContributorContext,
  RouteContributorOpenApiContext,
} from './http/route-contributor';

// HTTP seams: request containers, execution contexts, ambient access, body
// reading and the request-limit defaults
export { getRequestContainer } from './http/request-container';
export { buildExecutionContext as buildHttpExecutionContext } from './http/execution-context';
export {
  enableAmbientContainer,
  getCurrentContainer,
  getCurrentRequestContext,
  createLazyParamDecorator,
  readJsonBody,
  DEFAULT_BODY_LIMIT_BYTES,
  DEFAULT_QUERY_BYTES_LIMIT,
  DEFAULT_QUERY_DEPTH_LIMIT,
  DEFAULT_QUERY_PARAMETER_LIMIT,
} from './http/index';
export type { ReadJsonBodyOptions } from './http/index';
export type { RouteDescription } from './http/route.manager';

// Trusted request identity for authentication and tenancy integrations
export {
  clearTrustedRequestIdentity,
  getTrustedRequestIdentity,
  setTrustedRequestIdentity,
  setTrustedRequestTenant,
  createTrustedRequestIdentityStore,
  bindTrustedRequestContext,
  getTrustedContextRequest,
} from './http/trusted-request-identity';
export type {
  TrustedRequestIdentity,
  TrustedRequestPrincipal,
  TrustedRequestIdentityStore,
} from './http/trusted-request-identity';

// Request pipeline: run guards, interceptors, pipes and filters outside HTTP
export {
  PipelineRunner,
  getCatchTypes,
  shouldFilterCatch,
  getScopedComponents,
  resolveScopedComponents,
  resolveScopedComponentsAsync,
  resolvePipelineComponents,
} from './pipeline/index';
export type {
  PipelineComponentEntry,
  PipelineRunOptions,
  ResolvedComponentMap,
} from './pipeline/index';
export type {
  Constructor,
  MiddlewareType,
  GuardType,
  PipeType,
  InterceptorType,
  FilterType,
} from './registry/index';

// Error reporting for entrypoints outside the HTTP pipeline
export { resolveErrorReporter } from './exceptions/index';
export type { ErrorReporter } from './exceptions/index';
