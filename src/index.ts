// Factory & Application
export { cloudflareAdapter, createCloudflareApp } from './cloudflare-factory';
export type { CreateCloudflareAppOptions } from './cloudflare-factory';
export { CloudflareApplication } from './cloudflare-application';
export type { MountOpenApiOptions } from './cloudflare-application';

// Modules
export { KVModule } from './modules/kv.module';
export { D1Module } from './modules/d1.module';
export { R2Module } from './modules/r2.module';
export { QueueModule } from './modules/queue.module';
export { DurableObjectModule } from './modules/durable-object.module';
export { AIModule } from './modules/ai.module';
export { VectorizeModule } from './modules/vectorize.module';
export { HyperdriveModule } from './modules/hyperdrive.module';
export { EnvModule } from './modules/env.module';

// Storage (multi-disk over R2 + presign proxy)
export {
  StorageModule,
  StorageService,
  StorageManagerService,
  StorageController,
  R2StorageDriver,
  STORAGE_OPTIONS,
} from './storage/index';
export type { StorageModuleOptions, DiskConfig, PresignedUrlConfig } from './storage/index';

// Services
export { KVService } from './services/kv.service';
export { KVCacheStore } from './services/kv-cache.store';
export { D1Service } from './services/d1.service';
export { R2Service } from './services/r2.service';
export { QueueService } from './services/queue.service';
export { DurableObjectService } from './services/durable-object.service';
export { AIService } from './services/ai.service';
export { VectorizeService } from './services/vectorize.service';
export { HyperdriveService } from './services/hyperdrive.service';
export { EnvService } from './services/env.service';

// Feature-flag drivers (implement @velajs/feature-flags' FeatureFlagDriver contract)
export { FlagshipFlagDriver, flagshipFlagDriver } from './services/flagship-flag.driver';
export type { FlagshipBinding, FlagshipFlagDriverOptions } from './services/flagship-flag.driver';
export { KvFlagDriver, kvFlagDriver } from './services/kv-flag.driver';
export type { KvFlagDriverOptions } from './services/kv-flag.driver';

// Decorators
export { Env } from './decorators/env';
export { Scheduled } from './decorators/scheduled';
export { QueueConsumer } from './decorators/queue-consumer';

// WebSocket (Durable Object transport for the Vela WebSocketModule)
export {
  VelaWebSocketDurableObject,
  CloudflareWebSocketModule,
  broadcastToRoom,
} from './websocket/index';
export type { WsGatewayRoute } from './websocket/index';

// Live queries (Durable Object transport for @velajs/vela/live)
export {
  DoCursorLog,
  durableObjectCursorLog,
  durableObjectLive,
  liveInvalidateToRoom,
} from './websocket/index';
export type { CfLiveDriver, DurableObjectLiveOptions } from './websocket/index';
// Re-export the core gateway API so a Cloudflare app can import it from one place.
export {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
  WsException,
} from '@velajs/vela/websocket';
export type {
  WsClient,
  WsServer,
  WsResponse,
  WsMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@velajs/vela/websocket';

// Cloudflare Workflows (durable execution over @velajs/workflow's neutral core).
// Import @velajs/cloudflare pulls @velajs/workflow the same way it pulls
// @velajs/vela — the WorkflowModule declares the `cf:workflow` entrypoint kind at
// import time. Declare each workflow once as a `defineWorkflow` export, then
// consume it twice from one source: `WorkflowModule.forRoot({ workflows })` on
// the AppModule (ctx.workflows + the cf:workflow registry), and
// `createWorkflowEntrypoints(workflows, { rootModule })` in the Worker entry (the
// platform's WorkflowEntrypoint classes).
export { WorkflowModule } from './workflow/workflow.module';
export type { WorkflowModuleOptions } from './workflow/workflow.module';
export { WorkflowsService } from './workflow/workflows.service';
export { WorkflowRegistry } from './workflow/workflow-registry';
export {
  createWorkflowEntrypoint,
  createWorkflowEntrypoints,
  runWorkflowDefinition,
} from './workflow/create-workflow-entrypoint';
export type {
  CreateWorkflowEntrypointOptions,
  CreateWorkflowEntrypointsOptions,
  RunWorkflowDefinitionArgs,
  WorkflowEntrypointClass,
} from './workflow/create-workflow-entrypoint';
export {
  buildWorkflowRuntime,
  workflowReentryAdapter,
  DEFAULT_WORKFLOW_SERVICE_BINDING,
} from './workflow/build-workflow-runtime';
export type {
  BuildWorkflowRuntimeOptions,
  WorkflowRuntime,
} from './workflow/build-workflow-runtime';
export {
  WORKFLOW_DEFINITIONS,
  WORKFLOW_ENTRYPOINT_KIND,
  WORKFLOW_ENTRYPOINT_META_KEY,
  workflowBindingRefToken,
} from './workflow/tokens';
export type { AnyWorkflowDefinition, WorkflowEntrypointMeta } from './workflow/tokens';
// Re-export the workflow authoring surface so a Cloudflare app imports it from
// one place (mirrors the WebSocket gateway re-export above).
export {
  defineWorkflow,
  defineStep,
  WorkflowNonRetryableError,
  isWorkflowDefinition,
  workflowBindingName,
  workflowClassName,
  workflowDefaultName,
} from '@velajs/workflow';
export type {
  WorkflowDefinition,
  WorkflowHandle,
  Workflows,
  WorkflowRunContext,
  StepDefinition,
} from '@velajs/workflow';

// Types
export type { CloudflareEnv, ScheduledRegistration, QueueRegistration } from './types';
export type { ScheduledMetadata } from './decorators/scheduled';
export type { QueueConsumerMetadata } from './decorators/queue-consumer';
