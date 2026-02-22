import 'reflect-metadata';

// Factory & Application
export { CloudflareFactory } from './cloudflare-factory';
export { CloudflareApplication } from './cloudflare-application';

// Modules
export { KVModule } from './modules/kv.module';
export { D1Module } from './modules/d1.module';
export { R2Module } from './modules/r2.module';
export { QueueModule } from './modules/queue.module';

// Services
export { KVService } from './services/kv.service';
export { D1Service } from './services/d1.service';
export { R2Service } from './services/r2.service';
export { QueueService } from './services/queue.service';

// Decorators
export { Env } from './decorators/env';
export { Scheduled } from './decorators/scheduled';
export { QueueConsumer } from './decorators/queue-consumer';

// Internals (for advanced usage / testing)
export { BindingRef } from './binding-ref';
export { bindingsRegistry, clearBindingsRegistry } from './tokens';
export {
  KV_BINDING_REF,
  D1_BINDING_REF,
  R2_BINDING_REF,
  QUEUE_BINDING_REF,
} from './tokens';

// Types
export type { CloudflareEnv, ScheduledRegistration, QueueRegistration } from './types';
export type { ScheduledMetadata } from './decorators/scheduled';
export type { QueueConsumerMetadata } from './decorators/queue-consumer';
