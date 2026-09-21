/** Portable execution contracts. These are adapter interfaces, not native Cloudflare type mirrors. */
import type { input, output, ZodType } from 'zod';

export type WorkflowInstanceStatus =
  | 'complete'
  | 'errored'
  | 'paused'
  | 'queued'
  | 'running'
  | 'terminated'
  | 'unknown'
  | 'waiting'
  | 'waitingForPause';

export interface WorkflowStatusResult {
  status: WorkflowInstanceStatus;
  output?: unknown;
  error?: { name: string; message: string };
}

export interface WorkflowCreateOptions<Params = Record<string, unknown>> {
  id?: string;
  params?: Params;
  retention?: { successRetention?: string; errorRetention?: string };
}

export interface WorkflowInstanceLike {
  readonly id: string;
  status: () => Promise<WorkflowStatusResult>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  restart: () => Promise<void>;
  terminate: () => Promise<void>;
  sendEvent: (event: { type: string; payload: unknown }) => Promise<void>;
}

/** A producer-side binding supplied by the caller; no binding discovery is performed. */
export interface WorkflowBindingLike<Params = Record<string, unknown>> {
  create: (options?: WorkflowCreateOptions<Params>) => Promise<WorkflowInstanceLike>;
  createBatch: (
    batch: ReadonlyArray<WorkflowCreateOptions<Params>>,
  ) => Promise<WorkflowInstanceLike[]>;
  get: (id: string) => Promise<WorkflowInstanceLike>;
}

export interface WorkflowEventLike<Params = Record<string, unknown>> {
  readonly instanceId: string;
  readonly payload: Readonly<Params>;
  readonly timestamp: Date;
  readonly workflowName: string;
}

export interface WorkflowStepConfigLike {
  retries?: {
    /** Number of retries after the initial attempt. */
    limit: number;
    delay?: number | string;
    backoff?: 'constant' | 'linear' | 'exponential';
  };
  timeout?: number | string;
}

export interface WorkflowStepContextLike {
  /** Starts at one. */
  attempt: number;
  config: WorkflowStepConfigLike;
  step: { name: string; count: number };
}

export interface WorkflowRollbackContextLike<T = unknown> {
  ctx: WorkflowStepContextLike;
  error: Error;
  output: T | undefined;
  stepName: string;
}

export type WorkflowRollbackHandlerLike<T = unknown> = (
  context: WorkflowRollbackContextLike<T>,
) => Promise<void>;

/** Forwarded to an execution adapter. The replay harness does not execute compensation. */
export interface WorkflowStepRollbackOptionsLike<T = unknown> {
  rollback?: WorkflowRollbackHandlerLike<T>;
  rollbackConfig?: WorkflowStepConfigLike;
}

/** Portable durability primitives supplied by an execution adapter. */
export interface WorkflowStepLike {
  do: {
    <T>(
      name: string,
      callback: (context: WorkflowStepContextLike) => Promise<T>,
      rollback?: WorkflowStepRollbackOptionsLike<T>,
    ): Promise<T>;
    <T>(
      name: string,
      config: WorkflowStepConfigLike,
      callback: (context: WorkflowStepContextLike) => Promise<T>,
      rollback?: WorkflowStepRollbackOptionsLike<T>,
    ): Promise<T>;
  };
  sleep: (name: string, duration: number | string) => Promise<void>;
  sleepUntil: (name: string, timestamp: Date | number) => Promise<void>;
  /** External payloads are unknown until the application validates them. */
  waitForEvent: (
    name: string,
    options: { type: string; timeout?: number | string },
  ) => Promise<{ type: string; payload: unknown }>;
}

export type WorkflowRunTarget =
  | { readonly route: string; readonly params?: Record<string, string> }
  | { readonly path: string };

/** Structural subset compatible with Vela InternalDispatcher.run. */
export interface WorkflowRunInit {
  method?: string;
  body?: unknown;
  headers?: HeadersInit;
  ttlSeconds?: number;
  iss?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Inject per invocation. No signing, authorization, transport, or durability is added here. */
export type WorkflowRunFunction = (
  target: WorkflowRunTarget,
  init?: WorkflowRunInit,
) => Promise<unknown>;

export interface WorkflowLogger {
  debug: (message: string, ...rest: unknown[]) => void;
  info: (message: string, ...rest: unknown[]) => void;
  warn: (message: string, ...rest: unknown[]) => void;
  error: (message: string, ...rest: unknown[]) => void;
}

/** Zod 4 schemas. Arguments are parsed synchronously. */
export type StepArgsShape = Record<string, ZodType>;
/** Parsed values received by the handler. */
export type InferStepArgs<A extends StepArgsShape> = { [K in keyof A]: output<A[K]> };
/** Raw values accepted by runStep, including omitted optional/defaulted arguments. */
export type InferStepInput<A extends StepArgsShape> = {
  [K in keyof A as undefined extends input<A[K]> ? never : K]: input<A[K]>;
} & {
  [K in keyof A as undefined extends input<A[K]> ? K : never]?: input<A[K]>;
};

export interface StepRunContext {
  readonly attempt: number;
  readonly config: WorkflowStepConfigLike;
  readonly env: Record<string, unknown>;
  readonly log: WorkflowLogger;
  readonly run: WorkflowRunFunction;
  readonly step: { name: string; count: number };
}

export type StepHandler<A extends StepArgsShape, Result> = (
  context: StepRunContext,
  args: InferStepArgs<A>,
) => Promise<Result> | Result;

export interface StepRollbackContext<A extends StepArgsShape, Result> {
  readonly args: InferStepArgs<A>;
  readonly env: Record<string, unknown>;
  readonly error: Error;
  readonly log: WorkflowLogger;
  readonly output: Result | undefined;
  readonly run: WorkflowRunFunction;
}

export type StepRollbackHandler<A extends StepArgsShape, Result> = (
  context: StepRollbackContext<A, Result>,
) => Promise<void> | void;

/** With returns, the schema owns the public result type and validates the handler's unknown output. */
export interface StepConfig<A extends StepArgsShape, Result> {
  name: string;
  args: A;
  returns?: ZodType<Result>;
  handler: StepHandler<A, unknown>;
  config?: WorkflowStepConfigLike;
  rollback?: StepRollbackHandler<A, Result>;
  rollbackConfig?: WorkflowStepConfigLike;
}

export interface StepDefinition<
  A extends StepArgsShape = StepArgsShape,
  Result = unknown,
> extends StepConfig<A, Result> {
  readonly isVelaStep: true;
}

export interface RunStepOptions {
  /** Stable unique label for this call, useful when reusing a definition in a loop. */
  name?: string;
  config?: WorkflowStepConfigLike;
}

export type WorkflowRunStepFunction = <A extends StepArgsShape, Result>(
  step: StepDefinition<A, Result>,
  args: InferStepInput<A>,
  options?: RunStepOptions,
) => Promise<Result>;

export interface WorkflowRunContext<Params = Record<string, unknown>> {
  readonly env: Record<string, unknown>;
  readonly event: WorkflowEventLike<Params>;
  readonly log: WorkflowLogger;
  readonly params: Readonly<Params>;
  /** Wrap effects in step.do or runStep to memoize successful results. */
  readonly run: WorkflowRunFunction;
  readonly runStep: WorkflowRunStepFunction;
  readonly step: WorkflowStepLike;
}

export type WorkflowHandler<Params = Record<string, unknown>, Output = unknown> = (
  context: WorkflowRunContext<Params>,
) => Output | Promise<Output>;

/** Pure definition. Validate external params before constructing a typed context. */
export interface WorkflowConfig<Params = Record<string, unknown>, Output = unknown> {
  handler: WorkflowHandler<Params, Output>;
  name?: string;
}

export interface WorkflowDefinition<
  Params = Record<string, unknown>,
  Output = unknown,
> extends WorkflowConfig<Params, Output> {
  readonly isVelaWorkflow: true;
  readonly __params?: Params;
  readonly __output?: Output;
}

export interface WorkflowHandle<
  Params = Record<string, unknown>,
> extends WorkflowBindingLike<Params> {}

/** Parameter types come from the supplied bindings, never a caller-chosen result generic. */
export interface Workflows<
  B extends Record<string, WorkflowBindingLike<never>> = Record<string, WorkflowBindingLike>,
> {
  get: <Name extends keyof B & string>(
    name: Name,
  ) => WorkflowHandle<B[Name] extends WorkflowBindingLike<infer Params> ? Params : never>;
}

export interface CreateWorkflowsOptions<
  B extends Record<string, WorkflowBindingLike<never>> = Record<string, WorkflowBindingLike>,
> {
  bindings: B;
}
