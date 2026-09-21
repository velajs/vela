/**
 * The public type surface for `@velajs/agent`.
 *
 * The model and RAG seams are STRUCTURAL mirrors of `@velajs/ai` — declared
 * locally so nothing here imports `@velajs/ai` at runtime. `ai` (the Vercel AI
 * SDK) is a peer and is imported for the loop-control and schema types only;
 * `@velajs/workflow` supplies the injected `run`/`log` contracts. Keeping the
 * `@velajs/ai` mirror local (rather than importing it) is what lets an app pull
 * `@velajs/agent` without the AI package present — a type-conformance test proves
 * the two stay in lockstep (`Pick<Rag, 'retrieve'>` satisfies {@link RagLike}).
 */
import type { FlexibleSchema, LanguageModel, ToolChoice, ToolSet } from 'ai';
import type { WorkflowLogger, WorkflowRunFunction, WorkflowRunTarget } from '@velajs/workflow';

// TYPE-ONLY, erased at build. `./email` re-exports `@velajs/mail`'s `InboundEmail`
// so that module stays the single (type-only) mail boundary.
import type { AgentStopCondition } from './stop-conditions';
import type { InboundEmail } from './email';
import type {
  AgentMessage,
  AgentThreadReader,
  AgentThreadStatus,
  AgentThreadStore,
  AgentUsage,
} from './store';

/** The worker env bindings threaded through resolvers. */
export type Env = Record<string, unknown>;

/**
 * The model seam — a structural mirror of `@velajs/ai`'s `ModelInput` (itself the
 * AI SDK `LanguageModel`, which already admits a bare model-id string). Either a
 * resolved model / id, or an `(env) => model` thunk resolved once per run.
 */
export type AgentModelInput = LanguageModel | ((env: Env) => LanguageModel);

/**
 * The memory seam — a structural mirror of `@velajs/ai/rag`'s `Rag`, narrowed to
 * `retrieve`. Any object with a matching `retrieve` satisfies it (e.g.
 * `Pick<Rag, 'retrieve'>`). Declared locally, never imported at runtime.
 */
export interface RagLike {
  retrieve(
    query: string,
    options?: { topK?: number; namespace?: string; auth?: unknown },
  ): Promise<{
    context: string;
    chunks: ReadonlyArray<unknown>;
    sources: ReadonlyArray<unknown>;
  }>;
}

/**
 * Inject-mode memory config. Retrieved `context` remains untrusted data and is
 * placed in a delimited user message, never in the system prompt. `mode` is
 * `'inject'` only this batch; agentic/graph/
 * episodic tiers are deferred, so any other value throws at declare time.
 */
export interface AgentMemoryConfig {
  rag: RagLike | ((env: Env) => RagLike);
  mode?: 'inject';
  topK?: number;
  /** Tenant/shard key forwarded to `rag.retrieve`; isolation is the RagLike's job. */
  namespace?: string;
  /** Opaque identity forwarded to `rag.retrieve` for row-level security. */
  auth?: unknown;
  /** Resolve per-run retrieval authorization from the authenticated agent identity. */
  resolveScope?: (
    context: AgentRunIdentity & { env: Env; threadKey: string; runKey: string },
  ) => { namespace?: string; auth?: unknown } | Promise<{ namespace?: string; auth?: unknown }>;
  /**
   * A suffix that keys the retrieval's durable step name. `undefined` or
   * `'default'` yields the bare `memory:retrieve`; any other value yields
   * `memory:retrieve:<key>`.
   */
  key?: string;
}

/** Context passed to an `instructions` thunk. The thunk MUST be pure (replay-stable). */
export interface AgentInstructionsContext<Env2 extends Env = Env> {
  env: Env2;
  input: string;
  threadKey: string;
}

/**
 * What a tool's `execute` receives. `idempotencyKey` binds the authenticated scope, logical run, tool name,
 * call id, and input digest — dedupe any non-idempotent side effect
 * on it. There is deliberately NO `AbortSignal`: the durable path stays
 * deterministic, so cancellation is EXTERNAL (terminate the workflow instance)
 * rather than a mid-step abort.
 */
export interface AgentToolContext<Env2 extends Env = Env, Input = unknown> {
  /** The validated, model-provided args (also passed positionally as arg 0). */
  input: Input;
  env: Env2;
  /** Stable SHA-256-based capability key across step retries. Pass it to side-effect services. */
  idempotencyKey: string;
  /** The provider-issued stable tool-call id. */
  toolCallId: string;
  threadKey: string;
  runKey: string;
  /** Canonical authenticated owner of this run. */
  ownerId: string;
  /** Canonical authenticated tenant of this run. */
  tenantId: string;
  /** Read-only view of this run's own thread. */
  thread: AgentThreadReader;
  /** The injected `ctx.run` dispatcher — re-enter the app (used by `functionTool`). */
  run: WorkflowRunFunction;
  log: WorkflowLogger;
  /**
   * EPHEMERAL live-only progress sink. Fires only while `execute` runs inside its
   * memoized step, so it is best effort, and may repeat on uncheckpointed retries. A no-op unless a live transport wires
   * it (this batch ships no progress event on {@link AgentThreadEvent}).
   */
  reportProgress: (data: unknown) => void;
}

/**
 * A tool declaration. `needsApproval` is evaluated in a memoized durable step;
 * once a call is gated, replay cannot turn it into an ungated call. Keep the
 * predicate side-effect free. When truthy the loop parks on `waitForEvent`.
 */
export interface AgentToolDefinition<Input = unknown, Output = unknown> {
  description: string;
  inputSchema: FlexibleSchema<Input>;
  execute: (input: Input, ctx: AgentToolContext<Env, Input>) => Promise<Output> | Output;
  needsApproval?:
    | boolean
    | ((input: Input, ctx: AgentToolContext<Env, Input>) => boolean | Promise<boolean>);
  readonly isVelaAgentTool: true;
}

/**
 * The variance escape hatch for a heterogeneous tool map — same reason the AI
 * SDK's `ToolSet` erases its element types. This is the single documented `any`
 * in the package.
 */
// oxlint-disable-next-line typescript/no-explicit-any
export type AnyAgentTool = AgentToolDefinition<any, any>;

/** Input shape of a composed sub-agent tool (see `agentAsTool`). */
export interface AgentSubToolInput {
  prompt: string;
}

/** Options for composing a child agent as a tool. */
export interface AgentAsToolOptions {
  /** The child agent's export name; its workflow binding is `agentBindingName(name)`. */
  name: string;
  description: string;
  /** Max `status()` polls before giving up (default 60). */
  maxPolls?: number;
  /** Delay between polls in ms (default 500; `0` disables the delay — used in tests). */
  pollIntervalMs?: number;
  /** Only waiting composition is supported; false is rejected. */
  wait?: boolean;
}

/** Public config for `defineAgent`. */
export interface AgentConfig<Env2 extends Env = Env> {
  /** Required. A resolved model / id, or an `(env) => model` thunk. */
  model: AgentModelInput;
  /** System prompt: a string, or a PURE (replay-stable) `(ctx) => string` thunk. */
  instructions?: string | ((ctx: AgentInstructionsContext<Env2>) => string);
  /** Flat tool namespace; each key must match `/^[A-Za-z][\w-]*$/`. */
  tools?: Record<string, AnyAgentTool>;
  /** Restrict the exposed tools to this subset of `tools` keys. */
  activeTools?: ReadonlyArray<string>;
  /** AI SDK tool-choice; default `'auto'`. */
  toolChoice?: ToolChoice<ToolSet>;
  /** Inject-mode RAG memory. */
  memory?: AgentMemoryConfig;
  /** Positive integer turn budget; default 8. */
  maxTurns?: number;
  /** Agent stop condition(s), evaluated on completed tool turns. Import helpers from @velajs/agent. */
  stopWhen?: AgentStopCondition | ReadonlyArray<AgentStopCondition>;
  /** Structured final answer (zod | jsonSchema) — AI SDK `Output.object`. */
  output?: FlexibleSchema<unknown>;
  temperature?: number;
  maxOutputTokens?: number;
  /** BYO thread persistence — an instance or an `(env) => store` thunk. */
  store: AgentThreadStore | ((env: Env2) => AgentThreadStore);
  /**
   * Required trust boundary: derive a non-empty owner and tenant from an
   * authenticated trigger/runtime context. Run-param values are selectors only.
   */
  resolveRunIdentity: (
    context: AgentRunIdentityContext<Env2>,
  ) => AgentRunIdentity | Promise<AgentRunIdentity>;
  /**
   * Verify and atomically consume a human approval. The callback must authenticate
   * `approverId`, authorize it for the bound tenant/thread/tool call, verify any
   * application signature, and atomically record its verdict. A retry of the same fully bound nonce must
   * return its original verdict; any different binding must be rejected.
   * Missing verification fails closed for every gated tool.
   */
  verifyApproval?: (
    event: AgentApprovalEvent,
    context: AgentApprovalVerificationContext<Env2>,
  ) => boolean | Promise<boolean>;
  /** Maximum age of a human approval request. @default 900000 (15 minutes) */
  approvalTtlMs?: number;
  /** Live-only event sink (see {@link AgentThreadEvent}); best effort, and may repeat on uncheckpointed retries. */
  onThreadEvent?: (event: AgentThreadEvent) => void;
  /** Type-only inbound-email mapper (see `AgentEmailMapper`). */
  onEmail?: AgentEmailMapper;
  /** Deploy-name override; defaults to `agentDefaultName(exportName)`. */
  name?: string;
}

/**
 * A `defineAgent` result: the config, a brand, and `asTool` (bound `agentAsTool`)
 * so the agent can be composed into another agent's tool map.
 */
export type AgentDefinition<Env2 extends Env = Env> = AgentConfig<Env2> & {
  readonly isVelaAgent: true;
  asTool: (options: AgentAsToolOptions) => AgentToolDefinition<AgentSubToolInput, string>;
};

/** The trigger params of a compiled agent workflow. */
export interface AgentRunParams {
  threadKey: string;
  input: string;
  /**
   * A stable key for THIS logical run. Defaults to `event.instanceId`
   * (intra-instance replay stable). Supply a stable value so a genuine duplicate
   * DELIVERY reuses the same message keys and dedups at the store.
   */
  runKey?: string;
  /** Untrusted owner selector, validated only by `resolveRunIdentity`. */
  owner?: string;
  /** Untrusted tenant selector, validated only by `resolveRunIdentity`. */
  tenantId?: string;
  title?: string;
}

/** Trusted identity returned by `AgentConfig.resolveRunIdentity`. */
export interface AgentRunIdentity {
  ownerId: string;
  tenantId: string;
}

/** Inputs available while deriving trusted run identity. */
export interface AgentRunIdentityContext<Env2 extends Env = Env> {
  env: Env2;
  instanceId: string;
  runKey: string;
  threadKey: string;
  ownerSelector?: string;
  tenantSelector?: string;
}

/** Why the loop stopped, plus the final answer / structured output / usage. */
export interface AgentRunResult {
  stopped: 'final' | 'stopCondition' | 'maxTurns';
  text?: string;
  output?: unknown;
  turns: number;
  usage?: AgentUsage;
}

/** The public HITL resume-event type. */
export const AGENT_APPROVAL_EVENT_TYPE = 'agent:approval';

/**
 * The payload an app's resume endpoint sends to a parked run. Every binding is
 * copied from the `approval-requested` event; applications add `approverId` and
 * verify/consume the nonce through `AgentConfig.verifyApproval`.
 */
export interface AgentApprovalEvent {
  decision: 'approve' | 'reject';
  instanceId: string;
  threadKey: string;
  runKey: string;
  toolCallId: string;
  turn: number;
  toolName: string;
  inputDigest: string;
  nonce: string;
  expiresAt: number;
  approverId: string;
  ownerId: string;
  tenantId: string;
  note?: string;
}

/** Trusted context passed to an application's approval verifier. */
export interface AgentApprovalVerificationContext<Env2 extends Env = Env> {
  env: Env2;
  expected: Omit<AgentApprovalEvent, 'decision' | 'approverId' | 'note'>;
}

/** Best-effort live thread notifications. Subscribe with authorization and read
 * the store to recover missed events; these notifications are not an outbox. */
export type AgentThreadEvent =
  | { type: 'message'; threadKey: string; message: AgentMessage }
  | { type: 'status'; threadKey: string; status: AgentThreadStatus; error?: string }
  | {
      type: 'approval-requested';
      threadKey: string;
      toolCallId: string;
      toolName: string;
      approval: Omit<AgentApprovalEvent, 'decision' | 'approverId' | 'note'>;
    }
  | {
      type: 'approval-resolved';
      threadKey: string;
      toolCallId: string;
      decision: 'approve' | 'reject';
    };

/** A run start derived from an inbound email. */
export interface AgentEmailRun {
  input: string;
  threadKey: string;
  runKey?: string;
  owner?: string;
  tenantId?: string;
  title?: string;
}

/**
 * Maps a `@velajs/mail` `InboundEmail` to a run start, or `null`/`undefined` to
 * drop it. The `InboundEmail` type is imported TYPE-ONLY (see `./email`), so
 * `@velajs/mail` is never a runtime dependency.
 *
 * GATE-TRUST: CF Email Routing authenticates only the recipient domain.
 * `email.from`/subject/body are spoofable and a run dispatches privileged — a
 * mapper MUST gate on `email.authentication` (fail closed) and derive any owner
 * or tenant selectors from a verified signal, never blindly from `from`. The
 * agent's required identity resolver remains the canonical trust boundary.
 */
export type AgentEmailMapper = (
  email: InboundEmail,
) => AgentEmailRun | null | undefined | Promise<AgentEmailRun | null | undefined>;

/** Options for the plain-function `functionTool` variant. */
export interface FunctionToolConfig<Input, Output> {
  description: string;
  inputSchema: FlexibleSchema<Input>;
  execute: (input: Input, ctx: AgentToolContext<Env, Input>) => Promise<Output> | Output;
  needsApproval?:
    | boolean
    | ((input: Input, ctx: AgentToolContext<Env, Input>) => boolean | Promise<boolean>);
}

/** Options for the route-dispatch `functionTool(target, options)` variant. */
export interface RouteToolConfig<Input> {
  description: string;
  inputSchema: FlexibleSchema<Input>;
  needsApproval?:
    | boolean
    | ((input: Input, ctx: AgentToolContext<Env, Input>) => boolean | Promise<boolean>);
}

/** Re-exported so `functionTool`'s route variant is typed against the same shape. */
export type { WorkflowRunTarget };
