import {
  defineBinding,
  type Binding,
  type BindingKind,
  type BindingRef,
} from '@velajs/vela/module-kit';

/** Whether a value exposes every named operation as a function. */
function hasOperations(value: unknown, operations: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return operations.every((operation) => typeof Reflect.get(value, operation) === 'function');
}

/**
 * Name-based Workers binding factories. Each takes `{ binding }`, the name
 * declared in the Wrangler configuration, and returns a reference that reads
 * and validates the native binding from an application's `ENV` when called.
 * Declaring one reads no environment, so references belong in static module
 * options: `CacheModule.forRoot({ namespace, scope, store: kvCache({ binding: 'CACHE' }) })`.
 */

/** A KV namespace declared under `kv_namespaces`. */
export const KV_NAMESPACE: BindingKind<KVNamespace> = {
  name: 'KV namespace',
  configKey: 'kv_namespaces',
  accepts: (value): value is KVNamespace =>
    hasOperations(value, ['get', 'put', 'delete', 'list', 'getWithMetadata']),
};
export const kv = /* @__PURE__ */ defineBinding(KV_NAMESPACE);

/** An R2 bucket declared under `r2_buckets`. */
export const R2_BUCKET: BindingKind<R2Bucket> = {
  name: 'R2 bucket',
  configKey: 'r2_buckets',
  accepts: (value): value is R2Bucket =>
    hasOperations(value, ['get', 'put', 'head', 'delete', 'list', 'createMultipartUpload']),
};
export const r2 = /* @__PURE__ */ defineBinding(R2_BUCKET);

/** A D1 database declared under `d1_databases`. */
export const D1_DATABASE: BindingKind<D1Database> = {
  name: 'D1 database',
  configKey: 'd1_databases',
  accepts: (value): value is D1Database => hasOperations(value, ['prepare', 'batch', 'exec']),
};
export const d1 = /* @__PURE__ */ defineBinding(D1_DATABASE);

/** A queue producer declared under `queues.producers`. */
export const QUEUE_PRODUCER: BindingKind<Queue> = {
  name: 'queue producer',
  configKey: 'queues.producers',
  accepts: (value): value is Queue => hasOperations(value, ['send']),
};
export const queue = /* @__PURE__ */ defineBinding(QUEUE_PRODUCER);

/** A Durable Object namespace declared under `durable_objects.bindings`. */
export const DURABLE_OBJECT_NAMESPACE: BindingKind<DurableObjectNamespace> = {
  name: 'Durable Object namespace',
  configKey: 'durable_objects.bindings',
  accepts: (value): value is DurableObjectNamespace => hasOperations(value, ['idFromName', 'get']),
};
export const durableObject = /* @__PURE__ */ defineBinding(DURABLE_OBJECT_NAMESPACE);

/** A Workers Rate Limiting binding declared under `ratelimits`. */
export const RATE_LIMITER: BindingKind<RateLimit> = {
  name: 'rate limiter',
  configKey: 'ratelimits',
  accepts: (value): value is RateLimit => hasOperations(value, ['limit']),
};
export const rateLimit = /* @__PURE__ */ defineBinding(RATE_LIMITER);

/**
 * A reference to a Workflow binding declared under `workflows`, whose
 * instances take `Params`: for a class from `VelaWorkflow()`,
 * `workflow<WorkflowParams<SignupWorkflow>>({ binding: 'SIGNUP_WORKFLOW' })`.
 * Called with an application's ENV, it returns the native binding typed with
 * those params: `await signups(env).create({ params: { email } })`. The
 * runtime checks that the binding is a Workflow; its params are what the
 * Workflow class declares.
 */
export function workflow<Params = unknown>(ref: BindingRef): Binding<Workflow<Params>> {
  return defineBinding<Workflow<Params>>({
    name: 'Workflow',
    configKey: 'workflows',
    accepts: (value): value is Workflow<Params> => hasOperations(value, ['create', 'get']),
  })(ref);
}

/** A native Flagship binding declared under `flagship`. No flag values are cached. */
export const FLAGSHIP: BindingKind<Flagship> = {
  name: 'Flagship',
  configKey: 'flagship',
  accepts: (value): value is Flagship =>
    hasOperations(value, [
      'get',
      'getBooleanValue',
      'getStringValue',
      'getNumberValue',
      'getObjectValue',
      'getBooleanDetails',
      'getStringDetails',
      'getNumberDetails',
      'getObjectDetails',
    ]),
};
export const flagship = /* @__PURE__ */ defineBinding(FLAGSHIP);

/** A secret handle declared under `secrets_store_secrets`; resolve its value with `get()`. */
export const SECRETS_STORE_SECRET: BindingKind<SecretsStoreSecret> = {
  name: 'Secrets Store secret',
  configKey: 'secrets_store_secrets',
  accepts: (value): value is SecretsStoreSecret => hasOperations(value, ['get']),
};
export const secretsStoreSecret = /* @__PURE__ */ defineBinding(SECRETS_STORE_SECRET);
